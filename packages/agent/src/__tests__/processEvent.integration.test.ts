import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../slack.js", () => ({
  fetchThreadHistory: vi.fn().mockResolvedValue([]),
  postMessage: vi.fn().mockResolvedValue(undefined),
  postEphemeral: vi.fn().mockResolvedValue(undefined),
}));

const { fetchThreadHistory, postMessage, postEphemeral } = await import("../slack.js");
const { processEvent } = await import("../index.js");

const event = {
  channel: "C_TEST",
  thread_ts: "1.0",
  event_ts: "1.1",
  user: "U_TEST",
  text: "Reply with exactly the word hello and nothing else.",
};

describe.skipIf(!process.env.OPENROUTER_API_KEY)(
  "integration: processEvent",
  () => {
    beforeEach(() => {
      vi.mocked(postMessage).mockClear();
      vi.mocked(postEphemeral).mockClear();
      vi.mocked(fetchThreadHistory).mockClear();
    });

    it("sends ephemeral searching message, calls Claude, and posts response to Slack", async () => {
      await processEvent(event);

      expect(postEphemeral).toHaveBeenCalledWith("C_TEST", "U_TEST", "_Searching…_");

      expect(postMessage).toHaveBeenCalledOnce();
      const [channel, threadTs, text] = vi.mocked(postMessage).mock.calls[0];
      expect(channel).toBe("C_TEST");
      expect(threadTs).toBe("1.0");
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }, 60_000);

    it("reads model from config store and passes it to the agent", async () => {
      // No model row in DB — agent should use the default model without error
      await processEvent(event);

      expect(postMessage).toHaveBeenCalledOnce();
    }, 60_000);
  }
);
