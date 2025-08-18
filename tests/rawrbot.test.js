/**
 * @file index.test.js
 * Generic Jest tests for a Discord.js v14+ bot with mocked MongoDB
 */

const { EventEmitter } = require("events");

// --- Mock in-memory Map for message edits ---
const messageEdits = new Map();

// --- Mock MongoDB collection ---
const mockEditsCollection = {
  updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
};

// --- Minimal mock of Discord.js Client ---
class MockClient extends EventEmitter {
  async destroy() {
    return Promise.resolve();
  }
}

// --- Helper to create mock messages ---
function createMockMessage({ id, content }) {
  return {
    id,
    content,
    partial: false,
    channel: { id: "channel1" },
  };
}

// --- MessageUpdate handler (like your bot) ---
function handleMessageUpdate(oldMsg, newMsg) {
  if (!oldMsg.partial && !newMsg.partial) {
    if (!oldMsg.content || oldMsg.content === newMsg.content) return;

    const history = messageEdits.get(oldMsg.id) ?? [];
    const editEntry = { content: oldMsg.content, editedAt: new Date() };
    history.push(editEntry);
    messageEdits.set(oldMsg.id, history);

    // Persist to mocked MongoDB
    mockEditsCollection.updateOne(
      { messageId: oldMsg.id },
      {
        $push: { edits: editEntry },
        $setOnInsert: { channelId: oldMsg.channel?.id ?? "unknown" },
      },
      { upsert: true }
    );
  }
}

describe("Discord Bot (mocked client + MongoDB)", () => {
  let client;

  beforeEach(() => {
    client = new MockClient();
    messageEdits.clear();
    jest.clearAllMocks();

    // Attach messageUpdate listener
    client.on("messageUpdate", handleMessageUpdate);
  });

  afterEach(async () => {
    await client.destroy();
    messageEdits.clear();
  });

  test("client should be an instance of EventEmitter", () => {
    expect(client).toBeInstanceOf(EventEmitter);
  });

  test("ready event emits correctly", (done) => {
    client.once("ready", () => {
      expect(true).toBe(true);
      done();
    });

    client.emit("ready");
  });

  test("messageUpdate stores edits in-memory and calls MongoDB", (done) => {
    const oldMessage = createMockMessage({ id: "123", content: "Hello" });
    const newMessage = createMockMessage({ id: "123", content: "Hello world" });

    client.emit("messageUpdate", oldMessage, newMessage);

    setImmediate(() => {
      const edits = messageEdits.get("123");
      expect(edits).toHaveLength(1);
      expect(edits[0].content).toBe("Hello");

      // Verify MongoDB was called
      expect(mockEditsCollection.updateOne).toHaveBeenCalledTimes(1);
      expect(mockEditsCollection.updateOne).toHaveBeenCalledWith(
        { messageId: "123" },
        expect.objectContaining({
          $push: expect.any(Object),
          $setOnInsert: { channelId: "channel1" },
        }),
        { upsert: true }
      );

      done();
    });
  });

  test("messageUpdate ignores messages with same content", (done) => {
    const oldMessage = createMockMessage({ id: "456", content: "Same" });
    const newMessage = createMockMessage({ id: "456", content: "Same" });

    client.emit("messageUpdate", oldMessage, newMessage);

    setImmediate(() => {
      expect(messageEdits.get("456")).toBeUndefined();
      expect(mockEditsCollection.updateOne).not.toHaveBeenCalled();
      done();
    });
  });
});

module.exports = { messageEdits, handleMessageUpdate };
