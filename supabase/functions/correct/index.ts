/**
 * POST /functions/v1/correct
 *
 *   {
 *     "transactionId": "...",
 *     "productId": "...",          // or "productName" + "sectorSlug" to create one
 *     "applyToSimilar": true       // also fix every row with the same description
 *   }
 *
 * This is the learning loop, and it is the reason the system gets cheaper with
 * use. A correction does three things:
 *
 *   1. fixes the transaction
 *   2. records it in `corrections` (so the taxonomy can be audited and reverted)
 *   3. writes an ALIAS from the description's leading token to the product
 *
 * Step 3 is what matters. Next time resolveDeterministic() sees that merchant
 * string it matches the alias and the LLM is never called. On the sample file
 * 99.98% of rows already resolve for free; aliases are how a *bank* statement
 * gets there too, one correction at a time.
 */

import {
  corsHeaders, ensureProduct, fail, json, serviceClient, userIdFromRequest,
} from '../_shared/db.ts';
import { normalizeProductName } from '../_shared/taxonomy-seed.ts';

/** A pattern shorter than this is too generic to be a useful alias -- "tea"
 *  would shadow every tea merchant the user ever sees. */
const MIN_ALIAS_LENGTH = 3;
/** Cap on how many rows one "apply to similar" may touch, so a mistaken
 *  correction on a common description cannot silently rewrite the ledger. */
const MAX_SIMILAR = 2000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return fail('use POST', 405);

  const admin = serviceClient();

  try {
    const userId = await userIdFromRequest(req, admin);
    if (!userId) return fail('unauthenticated', 401);

    const body = (await req.json().catch(() => ({}))) as {
      transactionId?: string;
      transactionIds?: string[];
      productId?: string;
      productName?: string;
      sectorSlug?: string;
      applyToSimilar?: boolean;
    };

    const ids = Array.isArray(body.transactionIds) && body.transactionIds.length > 0
      ? body.transactionIds
      : body.transactionId ? [body.transactionId] : [];
    if (ids.length === 0) return fail('transactionId or transactionIds is required');

    // -- resolve the target product ------------------------------------------
    let productId = body.productId ?? null;

    if (!productId) {
      const name = (body.productName ?? '').trim();
      if (!name) return fail('productId, or productName + sectorSlug, is required');

      const sectorSlug = (body.sectorSlug ?? 'uncategorized').trim();
      const { data: sector } = await admin
        .from('sectors')
        .select('id')
        .eq('slug', sectorSlug)
        .maybeSingle();
      if (!sector) return fail(`unknown sector "${sectorSlug}"`, 422);

      const created = await ensureProduct(admin, userId, name, sector.id as string);
      if (!created) return fail(`could not create product "${name}"`, 500);
      productId = created.id;
    }

    // Verify the product belongs to this user. Without this, a crafted request
    // could point transactions at another tenant's product id -- the FK would
    // accept it because RLS is bypassed under the service role.
    const { data: product, error: prodErr } = await admin
      .from('products')
      .select('id, name, user_id, sector_id')
      .eq('id', productId)
      .maybeSingle();
    if (prodErr || !product) return fail('product not found', 404);
    if (product.user_id !== userId) return fail('product belongs to another user', 403);

    // -- load the transactions being corrected -------------------------------
    const { data: targets, error: tErr } = await admin
      .from('transactions')
      .select('id, product_id, raw_description, user_id')
      .eq('user_id', userId)
      .in('id', ids.slice(0, MAX_SIMILAR));
    if (tErr) return fail(`query failed: ${tErr.message}`, 500);
    if (!targets || targets.length === 0) return fail('no matching transactions', 404);

    // -- expand to similar rows if asked -------------------------------------
    let similarIds: string[] = [];
    const descriptions = new Set<string>();
    for (const t of targets) {
      const d = String(t.raw_description ?? '').trim();
      if (d) descriptions.add(d);
    }

    if (body.applyToSimilar && descriptions.size > 0) {
      const { data: similar } = await admin
        .from('transactions')
        .select('id, product_id, raw_description')
        .eq('user_id', userId)
        .in('raw_description', [...descriptions])
        .limit(MAX_SIMILAR);
      similarIds = (similar ?? []).map((r) => r.id as string);
    }

    const allIds = [...new Set([...targets.map((t) => t.id as string), ...similarIds])];

    // -- apply ----------------------------------------------------------------
    const { data: updated, error: uErr } = await admin
      .from('transactions')
      .update({
        product_id: productId,
        categorize_status: 'corrected',
        confidence: 1.0,
        categorize_reason: 'user correction',
      })
      .eq('user_id', userId)
      .in('id', allIds)
      .select('id, product_id');
    if (uErr) return fail(`update failed: ${uErr.message}`, 500);

    // Record the correction against the rows the user actually clicked. The
    // bulk-applied rows are a consequence, not a separate decision, so they do
    // not each get an audit row -- that would drown the history.
    const { error: cErr } = await admin.from('corrections').insert(
      targets.map((t) => ({
        user_id: userId,
        transaction_id: t.id,
        old_product_id: t.product_id,
        new_product_id: productId,
      })),
    );
    if (cErr) console.error('correction audit insert failed:', cErr.message);

    // -- learn aliases ---------------------------------------------------------
    // The leading segment of the synthesized description is the merchant/product
    // token ("Cha | Cold coffee at keventers" -> "Cha"). That is the reusable
    // part; the note after it is per-transaction context.
    const aliasesWritten: string[] = [];
    for (const desc of descriptions) {
      const lead = desc.split('|')[0].trim();
      const normLead = normalizeProductName(lead);
      if (normLead.length < MIN_ALIAS_LENGTH) continue;
      // An alias from "Cha" to the product "Cha" teaches nothing and would
      // shadow better rules, so skip it.
      if (normLead === normalizeProductName(String(product.name))) continue;

      const pattern = lead.toLowerCase();
      const { error: aErr } = await admin.from('aliases').upsert(
        {
          user_id: userId,
          product_id: productId,
          pattern,
          pattern_type: 'contains',
          source: 'correction',
          confidence: 1.0,
        },
        { onConflict: 'user_id,pattern' },
      );
      if (aErr) {
        // Not fatal: the correction already landed. Log it so a schema drift
        // (e.g. the unique index from 0006 missing) is visible.
        console.error('alias upsert failed:', aErr.message);
        continue;
      }
      aliasesWritten.push(pattern);
    }

    // Keep the product's use_count honest; it drives the "most used products
    // first" ordering in the taxonomy brief. Maintained by the statement-level
    // triggers in migration 0008, so no explicit update is needed here.

    return json({
      corrected: updated?.length ?? 0,
      clicked: targets.length,
      appliedToSimilar: body.applyToSimilar === true ? similarIds.length : 0,
      productId,
      productName: product.name as string,
      aliasesWritten,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('correct failed:', msg);
    return fail(msg, 500);
  }
});
