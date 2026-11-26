import React from "react";

function TextList({ items, empty }) {
  if (!items.length) return <p className="text-[var(--text-2)]">{empty}</p>;
  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

function EvidenceList({ ids, evidenceIndex }) {
  return (
    <ul className="text-xs text-[var(--text-2)] mt-1">
      {ids.map((id) => {
        const fact = evidenceIndex.get(id);
        return <li key={id}>{fact ? `${id}: ${fact.text}` : `${id}: not found in your current facts`}</li>;
      })}
    </ul>
  );
}

/**
 * Model-generated preparation brief. Everything renders as React text nodes;
 * no model output is ever interpreted as HTML.
 */
export default function AiPreparationBrief({ result, evidenceIndex }) {
  const { brief, model } = result;
  const source = model ? `AI brief (${model})` : "AI brief";
  return (
    <div className="text-sm mt-4" data-testid="ai-brief">
      <p className="text-xs text-[var(--text-2)]">
        {source}. Review it: it should only use the facts you approved.
      </p>
      <div className="grid md:grid-cols-2 gap-4 mt-2">
        <div>
          <h3 className="font-medium">Introduction</h3>
          <p className="whitespace-pre-wrap">{brief.introduction}</p>
        </div>
        <div>
          <h3 className="font-medium">Questions to ask</h3>
          <TextList items={brief.questionsToAsk} empty="No questions suggested." />
        </div>
        <div>
          <h3 className="font-medium">STAR examples</h3>
          {brief.starExamples.length === 0 && (
            <p className="text-[var(--text-2)]">No STAR example could be grounded in your approved facts.</p>
          )}
          {brief.starExamples.map((example) => (
            <article key={`${example.requirement}-${example.evidenceIds.join(",")}`} className="mb-3">
              <h4 className="font-medium">{example.requirement}</h4>
              <dl>
                <dt className="inline font-medium">Situation: </dt><dd className="inline">{example.situation}</dd><br />
                <dt className="inline font-medium">Task: </dt><dd className="inline">{example.task}</dd><br />
                <dt className="inline font-medium">Action: </dt><dd className="inline">{example.action}</dd><br />
                <dt className="inline font-medium">Result: </dt><dd className="inline">{example.result}</dd>
              </dl>
              <EvidenceList ids={example.evidenceIds} evidenceIndex={evidenceIndex} />
            </article>
          ))}
        </div>
        <div>
          <h3 className="font-medium">Practice topics</h3>
          <TextList items={brief.practiceTopics} empty="No practice topics suggested." />
          {brief.missingEvidence.length > 0 && (
            <>
              <h3 className="font-medium mt-3">Missing evidence</h3>
              <TextList items={brief.missingEvidence} empty="" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
