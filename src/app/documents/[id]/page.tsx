import { notFound } from "next/navigation";

import { WorkspaceView } from "@/components/WorkspaceView";
import { loadDocumentBundle } from "@/lib/storage/documents";
import { listConversations, listDocuments, listMessages } from "@/lib/storage/repository";

export const dynamic = "force-dynamic";

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ also?: string }>;
}) {
  const { id } = await params;
  const { also } = await searchParams;

  const bundle = await loadDocumentBundle(id);
  if (!bundle) notFound();

  const allDocuments = await listDocuments();
  const extraIds = (also ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== id && allDocuments.some((document) => document.id === value));

  const scopeIds = [id, ...extraIds];
  const conversations = await listConversations(id);
  const latest = conversations[0];
  const messages = latest ? await listMessages(latest.id) : [];

  return (
    <WorkspaceView
      primary={{
        id: bundle.record.id,
        title: bundle.record.title,
        kind: bundle.record.kind,
        text: bundle.record.text,
        pages: bundle.record.pages,
        clauses: bundle.clauses,
      }}
      allDocuments={allDocuments}
      initialScopeIds={scopeIds}
      conversations={conversations}
      initialConversationId={latest?.id ?? null}
      initialMessages={messages}
    />
  );
}
