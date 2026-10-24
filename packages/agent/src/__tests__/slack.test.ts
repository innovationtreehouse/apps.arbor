import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });
const mockPostEphemeral = vi.fn().mockResolvedValue({ ok: true });
const mockReplies = vi.fn().mockResolvedValue({ ok: true, messages: [] });
const mockHistory = vi.fn().mockResolvedValue({ ok: true, messages: [] });

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return {
      chat: { postMessage: mockPostMessage, postEphemeral: mockPostEphemeral },
      conversations: { replies: mockReplies, history: mockHistory },
    };
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

// Import after mocking
const { fetchThreadHistory, postMessage, fetchSlackImages } = await import("../slack.js");

beforeEach(() => {
  mockPostMessage.mockClear();
  mockReplies.mockClear();
  mockFetch.mockClear();
});

describe("fetchThreadHistory", () => {
  it("returns messages from conversations.replies", async () => {
    const messages = [
      { user: "U1", text: "hello", ts: "1.0" },
      { bot_id: "B1", text: "hi there", ts: "2.0" },
    ];
    mockReplies.mockResolvedValueOnce({ ok: true, messages });

    const result = await fetchThreadHistory("C_CHANNEL", "1.0");
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("hello");
  });

  it("passes channel, ts, and limit to the API", async () => {
    mockReplies.mockResolvedValueOnce({ ok: true, messages: [] });

    await fetchThreadHistory("C_TEST", "9.9");

    expect(mockReplies).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C_TEST", ts: "9.9", limit: 50 })
    );
  });

  it("returns empty array when messages is undefined", async () => {
    mockReplies.mockResolvedValueOnce({ ok: true });
    const result = await fetchThreadHistory("C1", "1.0");
    expect(result).toEqual([]);
  });
});

describe("postMessage", () => {
  it("posts a message to the correct channel and thread", async () => {
    await postMessage("C_CHAN", "1.0", "Hello Slack");
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_CHAN",
        thread_ts: "1.0",
        text: "Hello Slack",
      })
    );
  });

  it("truncates messages longer than 3900 characters", async () => {
    const longText = "x".repeat(4000);
    await postMessage("C1", "1.0", longText);

    const call = mockPostMessage.mock.calls[0][0];
    expect(call.text.length).toBeLessThanOrEqual(3900);
    expect(call.text.endsWith("…")).toBe(true);
  });

  it("does not truncate messages at exactly 3900 characters", async () => {
    const text = "y".repeat(3900);
    await postMessage("C1", "1.0", text);
    expect(mockPostMessage.mock.calls[0][0].text).toBe(text);
  });

  it("does not truncate short messages", async () => {
    await postMessage("C1", "1.0", "short");
    expect(mockPostMessage.mock.calls[0][0].text).toBe("short");
  });
});

describe("fetchSlackImages", () => {
  // Build a proper ArrayBuffer from known bytes so Buffer.from(ab) round-trips correctly
  const pngBytes = Buffer.from("fakepngdata");
  const pngArrayBuffer = pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength);

  it("returns empty array when no files provided", async () => {
    expect(await fetchSlackImages([])).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches and base64-encodes a supported image", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => pngArrayBuffer,
    });
    const results = await fetchSlackImages([
      { url_private: "https://files.slack.com/img.png", mimetype: "image/png" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].mediaType).toBe("image/png");
    expect(results[0].data).toBe(pngBytes.toString("base64"));
    expect(mockFetch).toHaveBeenCalledWith(
      "https://files.slack.com/img.png",
      expect.objectContaining({
        headers: { Authorization: "Bearer xoxb-test-token" },
      })
    );
  });

  it("skips unsupported mime types", async () => {
    const results = await fetchSlackImages([
      { url_private: "https://files.slack.com/doc.pdf", mimetype: "application/pdf" },
    ]);
    expect(results).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips images that exceed the size limit", async () => {
    const bigBuffer = new ArrayBuffer(5 * 1024 * 1024); // 5MB
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => bigBuffer,
    });
    const results = await fetchSlackImages([
      { url_private: "https://files.slack.com/big.png", mimetype: "image/png" },
    ]);
    expect(results).toEqual([]);
  });

  it("skips files that return a non-ok HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const results = await fetchSlackImages([
      { url_private: "https://files.slack.com/img.png", mimetype: "image/png" },
    ]);
    expect(results).toEqual([]);
  });

  it("skips files that throw a network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const results = await fetchSlackImages([
      { url_private: "https://files.slack.com/img.png", mimetype: "image/png" },
    ]);
    expect(results).toEqual([]);
  });

  it("processes multiple files and skips unsupported ones", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => pngBytes.buffer,
    });
    const results = await fetchSlackImages([
      { url_private: "https://files.slack.com/a.png", mimetype: "image/png" },
      { url_private: "https://files.slack.com/b.pdf", mimetype: "application/pdf" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].mediaType).toBe("image/png");
  });
});
