import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from "discord.js";
import { MongoClient, Collection } from "mongodb";

// Type for MongoDB edit entries
interface EditEntry {
  content: string;
  editedAt: Date;
}

// Type for MongoDB document
interface MessageEditDoc {
  messageId: string;
  channelId: string;
  edits: EditEntry[];
}

// In-memory storage for quick access
export const messageEdits = new Map<string, EditEntry[]>();

console.log("Starting bot...");

// --- Load environment variables ---
const token = process.env.DISCORD_TOKEN;
const mongoUri = process.env.MONGO_URI;

if (!token) {
  console.error("Missing DISCORD_TOKEN in environment variables.");
  process.exit(1);
}
if (!mongoUri) {
  console.error("Missing MONGO_URI in environment variables.");
  process.exit(1);
}

// --- MongoDB setup ---
const mongoClient = new MongoClient(mongoUri);
let editsCollection: Collection<MessageEditDoc>;

async function initMongo() {
  try {
    await mongoClient.connect();
    const db = mongoClient.db("rawrbot"); // database name
    editsCollection = db.collection<MessageEditDoc>("messageEdits");
    console.log("Connected to MongoDB.");
  } catch (err) {
    console.error("Failed to connect to MongoDB.");
    console.error(err);
    process.exit(1);
  }
}

// --- Create the Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// --- Ready listener ---
client.once(Events.ClientReady, (c) => {
  console.log(`✅ RawrBot is ready! Logged in as ${c.user?.tag}`);
});

// --- Message update listener ---
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (!oldMessage.partial && !newMessage.partial) {
    if (!oldMessage.content || oldMessage.content === newMessage.content) return;

    const history = messageEdits.get(oldMessage.id) ?? [];
    const editEntry: EditEntry = {
      content: oldMessage.content,
      editedAt: new Date(),
    };

    // Update in-memory
    history.push(editEntry);
    messageEdits.set(oldMessage.id, history);

    // Persist to MongoDB
    try {
      await editsCollection.updateOne(
        { messageId: oldMessage.id },
        {
          $push: { edits: editEntry },
          $setOnInsert: { channelId: oldMessage.channel?.id ?? "unknown" },
        },
        { upsert: true }
      );
    } catch (err) {
      console.error("Error saving message edit to MongoDB.");
      console.error(err);
    }
  }
});

// --- Startup sequence ---
(async () => {
  await initMongo();

  client
    .login(token)
    .then(() => console.log("Client login successful."))
    .catch((err) => {
      console.error("Client login failed, make sure your token is correct.");
      console.error(err);
      process.exit(1);
    });
})();

// --- Process-level error handling ---
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception.");
  console.error(err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection.");
  console.error(err);
});

// --- Graceful shutdown ---
process.on("SIGINT", async () => {
  console.log("Received SIGINT, gracefully shutting down...");
  try {
    await client.destroy();
    await mongoClient.close();
    console.log("Client and DB connection closed.");
  } catch (err) {
    console.error("Error while shutting down.");
    console.error(err);
  }
  console.log("Exiting...");
  process.exit(0);
});
