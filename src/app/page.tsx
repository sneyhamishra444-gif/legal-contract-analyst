import { LibraryView } from "@/components/LibraryView";
import { listDocuments } from "@/lib/storage/repository";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const documents = await listDocuments();
  return <LibraryView initialDocuments={documents} />;
}
