import test from "node:test";
import assert from "node:assert/strict";
import { parseInterviewContext, isCandidateInterviewContext } from "../server/contracts/interviewContext.js";
import { createReplayHarness } from "./helpers/replayHarness.js";
import {
  loadContexts,
  loadFixture,
  loadProviderResponses,
  resolveContextCase,
} from "./helpers/fixtures.js";

const contexts = loadContexts();
const { responses } = loadProviderResponses();
const malformed = loadFixture("malformedMessages.json");

for (const [name, fixture] of Object.entries(contexts.valid)) {
  test(`context fixture ${name} is accepted, stored, and gets one intro suggestion`, async () => {
    const parsed = parseInterviewContext(fixture.payload);
    assert.equal(isCandidateInterviewContext(fixture.payload), fixture.expect.kind === "candidate");

    const harness = createReplayHarness({ responses, contexts, providerScript: ["introSuccess"] });
    await harness.send({ context: fixture.payload });

    assert.deepEqual(harness.outbound, [{ ai_reply: responses.introSuccess.content, model: { selected: "fixture/model", actual: null } }]);
    assert.deepEqual(await harness.ContextStore.get(harness.sessionId), parsed);
    assert.equal(harness.streamManager.transcriptionLanguage, fixture.expect.transcriptionLanguage);
    if (fixture.expect.kind === "candidate") {
      assert.equal(parsed.settings.language, fixture.expect.language);
      assert.match(harness.provider.calls[0].system, new RegExp(`- Name: ${parsed.candidate.name}`));
    }
  });
}

for (const testCase of contexts.invalid) {
  test(`context fixture "${testCase.name}" is rejected without storage or a provider call`, async () => {
    const payload = resolveContextCase(contexts, testCase);
    assert.throws(() => parseInterviewContext(payload));

    const harness = createReplayHarness({ responses, contexts });
    await harness.send({ context: payload });

    assert.deepEqual(harness.outbound, [{ error: "Invalid message" }]);
    assert.equal(await harness.ContextStore.get(harness.sessionId), null);
    assert.equal(harness.provider.calls.length, 0);
  });
}

for (const testCase of contexts.unsupportedVersions) {
  test(`context fixture "${testCase.name}" is rejected with an explicit error and nothing stored`, async () => {
    const payload = resolveContextCase(contexts, testCase);
    assert.throws(() => parseInterviewContext(payload), { code: "unsupported_context_version" });

    const harness = createReplayHarness({ responses, contexts });
    await harness.send({ context: payload });

    assert.deepEqual(harness.outbound, [testCase.expect]);
    assert.equal(await harness.ContextStore.get(harness.sessionId), null);
    assert.equal(harness.provider.calls.length, 0);
  });
}

test("an unsupported context version keeps the previously stored context", async () => {
  const harness = createReplayHarness({ responses, contexts, providerScript: ["introSuccess"] });
  await harness.send({ context: contexts.valid.validEn.payload });
  const stored = await harness.ContextStore.get(harness.sessionId);

  await harness.send({ context: { ...contexts.valid.validEn.payload, version: 2 } });

  assert.deepEqual(harness.outbound.at(-1), { error: "unsupported_context_version" });
  assert.deepEqual(await harness.ContextStore.get(harness.sessionId), stored);
  assert.equal(harness.provider.calls.length, 1);
});

test("malformed client frames are rejected without side effects and the socket stays usable", async () => {
  const harness = createReplayHarness({ responses, contexts, providerScript: ["introSuccess"] });
  const expected = [];

  for (const testCase of malformed.cases) {
    if ("raw" in testCase) await harness.sendRaw(testCase.raw);
    else await harness.send(testCase.message);
    expected.push(...testCase.expect);
    assert.deepEqual(harness.outbound, expected, testCase.name);
  }

  assert.equal(harness.deepgram.connections.length, 0, "no transcription stream was opened");
  assert.equal(harness.provider.calls.length, 0, "no provider request was made");
  assert.deepEqual(await harness.ChatHistory.get(harness.sessionId), []);

  await harness.send({ context: contexts.valid.validEn.payload });
  assert.deepEqual(harness.outbound.at(-1), { ai_reply: responses.introSuccess.content, model: { selected: "fixture/model", actual: null } });
});
