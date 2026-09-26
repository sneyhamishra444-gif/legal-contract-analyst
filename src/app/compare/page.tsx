import { CompareView } from "@/components/CompareView";
import { listDocuments } from "@/lib/storage/repository";

export const dynamic = "force-dynamic";

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ left?: string; right?: string }>;
}) {
  const { left, right } = await searchParams;
  const documents = await listDocuments();
  return <CompareView documents={documents} initialLeft={left ?? null} initialRight={right ?? null} />;
}
