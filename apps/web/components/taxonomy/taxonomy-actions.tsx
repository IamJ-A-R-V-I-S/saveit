"use client";

import { useState, useTransition } from "react";
import { createProduct, mergeProducts, moveProduct } from "@/lib/actions/taxonomy";
import { Badge, Card, CardBody, CardHeader, SectorIcon, cx } from "@/components/ui";
import { count } from "@/lib/format";
import type { Product, Sector } from "@/lib/types";

/**
 * Taxonomy maintenance.
 *
 * Products grow by themselves during ingest. What needs a human is merging:
 * `Cha`, `chai` and `Cha (evening)` are one thing described three ways, and
 * left alone they fragment exactly the reporting the app exists to produce.
 */

type Feedback = { tone: "ok" | "err"; text: string } | null;

export function MergePanel({
  candidates,
}: {
  candidates: { keep: Product; drop: Product; reason: string }[];
}) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const open = candidates.filter((c) => !done.has(`${c.keep.id}:${c.drop.id}`));

  if (open.length === 0) {
    return (
      <Card>
        <CardBody className="py-8 text-center text-sm text-muted">
          {candidates.length === 0
            ? "No near-duplicates found. Your products are clean."
            : "All suggested merges handled."}
        </CardBody>
      </Card>
    );
  }

  function merge(keepId: string, dropId: string, keepName: string, dropName: string) {
    setFeedback(null);
    startTransition(async () => {
      const result = await mergeProducts(keepId, dropId);
      if (!result.ok) {
        setFeedback({ tone: "err", text: result.error });
        return;
      }
      setDone((prev) => new Set([...prev, `${keepId}:${dropId}`]));
      setFeedback({
        tone: "ok",
        text: `Merged “${dropName}” into “${keepName}”. Its transactions and aliases moved over, and the duplicate is archived.`,
      });
    });
  }

  return (
    <Card>
      <CardHeader
        title="Possible duplicates"
        hint="Same sector, names one edit apart. Merging keeps the more-used product and moves everything across."
        action={<Badge tone="warning">{open.length}</Badge>}
      />
      <CardBody className="space-y-3">
        {feedback ? (
          <p
            role="status"
            className={cx(
              "rounded-lg border px-3 py-2 text-xs",
              feedback.tone === "ok"
                ? "border-success/25 bg-success-soft text-success"
                : "border-danger/25 bg-danger-soft text-danger",
            )}
          >
            {feedback.text}
          </p>
        ) : null}

        <ul className="space-y-2">
          {open.slice(0, 12).map((c) => (
            <li
              key={`${c.keep.id}:${c.drop.id}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-2"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-ink">{c.keep.name}</span>
                <span className="text-[11px] text-faint">{count(c.keep.use_count)}×</span>
                <span className="text-muted" aria-hidden>
                  ←
                </span>
                <span className="text-muted line-through">{c.drop.name}</span>
                <span className="text-[11px] text-faint">{count(c.drop.use_count)}×</span>
                <Badge>{c.reason}</Badge>
              </span>

              <span className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => merge(c.keep.id, c.drop.id, c.keep.name, c.drop.name)}
                  className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                >
                  Merge
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => merge(c.drop.id, c.keep.id, c.drop.name, c.keep.name)}
                  className="rounded-md border border-line-strong px-2.5 py-1 text-[11px] font-semibold text-muted hover:bg-sunken disabled:opacity-50"
                  title={`Keep “${c.drop.name}” instead`}
                >
                  Reverse
                </button>
                <button
                  type="button"
                  onClick={() => setDone((prev) => new Set([...prev, `${c.keep.id}:${c.drop.id}`]))}
                  className="rounded-md px-2 py-1 text-[11px] font-medium text-faint hover:text-ink"
                >
                  Skip
                </button>
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export function CreateProductForm({ sectors }: { sectors: Sector[] }) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, startTransition] = useTransition();

  async function submit(formData: FormData) {
    setFeedback(null);
    startTransition(async () => {
      const result = await createProduct({
        name: String(formData.get("name") ?? ""),
        sectorSlug: String(formData.get("sectorSlug") ?? ""),
      });
      if (!result.ok) {
        setFeedback({ tone: "err", text: result.error });
        return;
      }
      setFeedback({ tone: "ok", text: "Product created. Descriptions matching it will file there." });
      setOpen(false);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-line-strong px-3.5 py-2 text-sm font-semibold text-ink hover:bg-surface"
      >
        + New product
      </button>
    );
  }

  return (
    <Card>
      <CardBody>
        <form action={submit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-45 flex-1">
            <label className="label" htmlFor="new-product">
              Product name
            </label>
            <input
              id="new-product"
              name="name"
              required
              autoFocus
              className="field"
              placeholder="How do you call it? e.g. Cha, Uber, Jio recharge"
            />
          </div>
          <div className="min-w-40">
            <label className="label" htmlFor="new-sector">
              Sector
            </label>
            <select id="new-sector" name="sectorSlug" className="field" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {sectors.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.icon ? `${s.icon} ` : ""}
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Adding…" : "Add"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:text-ink"
          >
            Cancel
          </button>

          {feedback ? (
            <p
              role="status"
              className={cx(
                "w-full rounded-lg border px-3 py-2 text-xs",
                feedback.tone === "ok"
                  ? "border-success/25 bg-success-soft text-success"
                  : "border-danger/25 bg-danger-soft text-danger",
              )}
            >
              {feedback.text}
            </p>
          ) : null}
        </form>
      </CardBody>
    </Card>
  );
}

/**
 * Move a product between sectors.
 *
 * Cheaper than deleting and recreating: the name keeps its aliases and its
 * transaction history, so the resolver's learned behaviour survives the move.
 */
export function MoveProduct({
  product,
  sectors,
}: {
  product: Product;
  sectors: Sector[];
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-1.5">
      <select
        aria-label={`Move ${product.name} to another sector`}
        defaultValue={product.sector?.slug ?? ""}
        disabled={pending}
        onChange={(e) => {
          const slug = e.target.value;
          if (!slug || slug === product.sector?.slug) return;
          setMessage(null);
          startTransition(async () => {
            const result = await moveProduct(product.id, slug);
            setMessage(result.ok ? "Moved." : result.error);
          });
        }}
        className="field w-auto py-0.5 pr-6 text-[11px]"
      >
        {sectors.map((s) => (
          <option key={s.slug} value={s.slug}>
            {s.name}
          </option>
        ))}
      </select>
      {message ? (
        <span
          className={cx(
            "text-[10px]",
            message === "Moved." ? "text-success" : "text-danger",
          )}
        >
          {message}
        </span>
      ) : null}
    </span>
  );
}

export function SectorProductList({
  sectors,
  products,
}: {
  sectors: Sector[];
  products: Product[];
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {sectors.map((sector) => {
        const inSector = products.filter((p) => p.sector_id === sector.id);
        const uses = inSector.reduce((n, p) => n + (p.use_count ?? 0), 0);

        return (
          <Card key={sector.id}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <SectorIcon icon={sector.icon} />
                  {sector.name}
                </span>
              }
              hint={`${count(inSector.length)} product${inSector.length === 1 ? "" : "s"} · ${count(uses)} transaction${uses === 1 ? "" : "s"}`}
            />
            <CardBody className="py-3">
              {inSector.length === 0 ? (
                <p className="py-2 text-xs text-faint">
                  Nothing here yet. Products appear as your statements mention them.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {inSector.slice(0, 12).map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">{p.name}</span>
                      <span className="tnum shrink-0 text-[11px] text-faint">
                        {count(p.use_count)}×
                      </span>
                      <MoveProduct product={{ ...p, sector }} sectors={sectors} />
                    </li>
                  ))}
                  {inSector.length > 12 ? (
                    <li className="pt-1 text-[11px] text-faint">
                      + {count(inSector.length - 12)} more
                    </li>
                  ) : null}
                </ul>
              )}
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}
