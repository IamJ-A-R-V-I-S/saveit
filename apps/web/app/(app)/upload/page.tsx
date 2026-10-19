import type { Metadata } from "next";
import { PageHeading } from "@/components/page-heading";
import { Uploader } from "@/components/upload/uploader";
import { getAccounts } from "@/lib/data/transactions";

export const metadata: Metadata = { title: "Upload a statement" };

export default async function UploadPage() {
  const accounts = await getAccounts();

  return (
    <>
      <PageHeading
        title="Upload a statement"
        sub="Bank export, UPI statement, tracker CSV, or a photo of a paper one. SaveIt parses it, deduplicates against what you've already imported, and categorizes every row."
      />
      <div className="mt-6">
        <Uploader accounts={accounts} />
      </div>
    </>
  );
}
