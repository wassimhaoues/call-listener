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

test("context quirks keep their current, documented behavior", () => {
  for (const testCase of contexts.quirks) {
    const parsed = parseInterviewContext(resolveContextCase(contexts, testCase));
    assert.equal(testCase.expect.kind, "legacy-empty");
    // Zod 4 object defaults short-circuit, so the nested field defaults are absent.
    assert.deepEqual(parsed, { caller: {}, me: {} }, testCase.name);
  }
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
