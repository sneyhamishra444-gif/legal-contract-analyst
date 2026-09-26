# Note on approach

## Quote verification, and where it could fail

The model writes its citations as `<quote doc="p3">…</quote>`. The server streams the
raw text, parses each completed quote out, verifies it, and emits the verdict before
it emits the finished answer. Nothing the model says about a *location* is used: the
page number, offset and span shown to the reader all come from my own search of the
extracted text, because a model that invents a quote will happily invent its
location too.

Matching runs down a ladder — exact (whitespace, line breaks, typographic quotes,
dashes, ligatures, ellipses and invisible characters folded away), then
case-insensitive, then punctuation trimmed at the edges, then hyphen-joined for a
word the document split across a line break. No step can reorder, substitute or drop
a word, which is what makes a paraphrase fail every one of them. A quote containing
an ellipsis or a bracketed insertion is split into segments, every segment must be
located in order, and any segment that is not found is named rather than glossed
over. Verified quotes pass; a quote that is partly found is reported as partly
found; anything else is marked as not in the document, shown struck through, with the
closest passage disclosed separately and labelled as reference only — never as a
quotation.

It can still fail. If the document itself mangles a word — a broken ligature, a
character the extractor drops — a genuinely present quote can be rejected. That
direction of error is the safe one; the reverse, accepting a fabrication, is only
possible if a paraphrase happens to reproduce a long run of the document verbatim,
which is not really a paraphrase. Tolerant layers can also in principle match at the
wrong occurrence of a repeated sentence; this is why the occurrence the answer
actually drew from is preferred over the first, and why repeats are counted and can
be stepped through. And a quote can be genuine but prove nothing — a four-word
fragment is verified, so short quotes are labelled as weak evidence.

## Large documents

The 153-page fixture (505,000 characters, 747 clauses) is chunked on clause
boundaries, so a chunk never straddles two top-level clauses. Retrieval searches
*every* chunk — BM25 with a phrase bonus — and a test confirms it reaches a clause in
the last 3% of that document. If the model is reasoning over the text, the agent
decides what to read through its tools, so only what it asks for is ever sent.

The rule I took most seriously is that the app must not answer as though it read more
than it did. Every answer carries a coverage report and a plain sentence saying how
much of the document was searched, rendered in a banner under the answer. If the
round cap or the tool-call budget is hit first, the answer is badged "research cut
short". A confidently wrong "there is no such clause" is the worst output this app
could produce, so retrieval reports *no match* rather than the least-bad passage, and
the answer says the document does not appear to cover the question.

## Part C: Option 2, and how far it got

I picked agentic document research because it addresses the real problem rather than
a decorative one. A 150-page contract does not fit in a prompt, so something has to
choose what to read; making that the model's job — with real tools, real results and
visible reasoning — is the honest architecture, and it is also the more interesting
problem. Tracking changes in a `.docx` is a formatting problem; this is a retrieval
and trust problem, which is the whole assignment.

It works end to end. The loop runs real rounds, the tools execute against the indexed
document, progress is streamed as steps ("Searching the document for liability
cap…") rather than a spinner, the round cap and an eight-call tool budget end the
loop honestly, and malformed or invented tool calls — unknown name, missing
arguments, wrong types, nonsense parameters — get one repair attempt and then a
correction message, never a failed request. Final quotes go through the same
verification as any other answer.

The hardest part was not the loop. It was keeping the agent from *looking*
productive: a model will happily call `search_document` with the question verbatim,
get nothing, and try again with a worse query, and the failure mode is a confident
answer built on a bad passage. The work went into retrieval quality underneath the
agent — phrase bonuses, a stopword list tuned for contract questions, clause-level
chunking, and reporting coverage alongside every answer — plus making the caps
visible so a truncated answer never reads as a complete one. It has only been
exercised against the deterministic offline provider here (no API key was available),
so the tool-calling loop itself is tested but not yet driven by a real model.

## With more time

1. **Run it against a real model**, which is the honest first step, and tune the
   planner prompt against observed tool-calling behaviour rather than the offline
   stand-in.
2. **Real Postgres in CI**, so the second database driver is exercised rather than
   argued about.
3. **Embeddings as a second retrieval signal** alongside BM25, to catch a question
   that shares no vocabulary with the clause.
4. **Clause typing** — classifying clauses as termination, liability, governing law —
   which would turn the outline into something the comparison and the agent could
   both reason over directly.
5. **Export** an answer with its verified quotes as a PDF, which is the natural
   end of "I found this and I can prove it".
