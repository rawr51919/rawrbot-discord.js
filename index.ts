import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { MongoClient, Collection } from "mongodb";

// --- Types ---
interface EditEntry {
  content: string;
  editedAt: Date;
}

interface MessageEditDoc {
  messageId: string;
  channelId: string;
  edits: EditEntry[];
}

// --- In-memory storage ---
export const messageEdits = new Map<string, EditEntry[]>();

// --- Load environment variables ---
const token = process.env.DISCORD_TOKEN;
const mongoUri = process.env.MONGO_URI;
const clientId = process.env.DISCORD_APP_ID;

if (!token || !mongoUri || !clientId) {
  console.error("Missing DISCORD_TOKEN, MONGO_URI, or DISCORD_APP_ID.");
  process.exit(1);
}

// --- MongoDB setup ---
const mongoClient = new MongoClient(mongoUri);
let editsCollection: Collection<MessageEditDoc>;

async function initMongo() {
  try {
    await mongoClient.connect();
    const db = mongoClient.db("rawrbot");
    editsCollection = db.collection<MessageEditDoc>("messageEdits");
    console.log("Connected to MongoDB.");
  } catch (err) {
    console.error("Failed to connect to MongoDB.", err);
    process.exit(1);
  }
}

// --- Discord client setup ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// --- Resolve __dirname in ESM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Load commands and register globally ---
async function registerGlobalCommands() {
  const commands: any[] = [];
  const commandsPath = path.join(__dirname, "commands");

  if (!fs.existsSync(commandsPath)) {
    console.warn("Commands folder not found:", commandsPath);
    return;
  }

  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter(f => f.endsWith(".ts") || f.endsWith(".js"));

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const commandModule = await import(`file://${filePath}`);
    const command = commandModule.default ?? commandModule;
    if (command.data?.toJSON) commands.push(command.data.toJSON());
  }

  try {
    if (!client.application) {
      console.error("Client application is not ready yet.");
      return;
    }

    console.log(`Registering ${commands.length} global commands...`);
    await client.application.commands.set(commands); // ✅ Avoids REST/undici
    console.log("Global commands registered successfully!");
  } catch (err) {
    console.error("Error registering global commands:", err);
  }
}

// --- Ready listener ---
client.once(Events.ClientReady, async c => {
  console.log(`✅ RawrBot is ready! Logged in as ${c.user?.tag}`);

  try {
    const registeredCommands = await client.application?.commands.fetch();
    console.log(
      "Registered global commands:",
      registeredCommands?.map(cmd => cmd.name) ?? []
    );
  } catch (err) {
    console.error("Error fetching commands:", err);
  }
});

// --- Message update listener ---
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (!oldMessage.partial && !newMessage.partial) {
    if (!oldMessage.content || oldMessage.content === newMessage.content) return;

    const history = messageEdits.get(oldMessage.id) ?? [];
    const editEntry: EditEntry = { content: oldMessage.content, editedAt: new Date() };

    // Update in-memory
    history.push(editEntry);
    messageEdits.set(oldMessage.id, history);

    // Persist to MongoDB
    try {
      await editsCollection.updateOne(
        { messageId: oldMessage.id },
        { $push: { edits: editEntry }, $setOnInsert: { channelId: oldMessage.channel?.id ?? "unknown" } },
        { upsert: true }
      );
    } catch (err) {
      console.error("Error saving message edit to MongoDB.", err);
    }
  }
});

// --- Startup sequence ---
(async () => {
  await initMongo();
  await client.login(token);
  console.log("Client login successful.");

  await registerGlobalCommands();
})();

// --- Process-level error handling ---
process.on("uncaughtException", (err) => console.error("Uncaught exception.", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection.", err));

// --- Graceful shutdown ---
process.on("SIGINT", async () => {
  console.log("Received SIGINT, shutting down...");
  try {
    await client.destroy();
    await mongoClient.close();
    console.log("Client and DB connection closed.");
  } catch (err) {
    console.error("Error during shutdown.", err);
  }
  process.exit(0);
});
