const { Client, GatewayIntentBits } = require('discord.js');
const { OpenAI } = require('openai');
require('dotenv').config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const sleep = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// When discord bot has started up
client.once('ready', () => {
  console.log('Bot is ready!');
});

const threadMap = {};

const getOpenAiThreadId = (discordThreadId) => {
  // Replace this in-memory implementation with a database (e.g. DynamoDB, Firestore, Redis)
  return threadMap[discordThreadId];
};

const addThreadToMap = (discordThreadId, openAiThreadId) => {
  threadMap[discordThreadId] = openAiThreadId;
};

const terminalStates = ['cancelled', 'failed', 'completed', 'expired'];
const statusCheckLoop = async (openAiThreadId, runId) => {
  const run = await openai.beta.threads.runs.retrieve(openAiThreadId, runId);

  if (terminalStates.indexOf(run.status) < 0) {
    await sleep(1000);
    return statusCheckLoop(openAiThreadId, runId);
  }
  // console.log(run);

  return run.status;
};

const addMessage = (threadId, content) => {
  // console.log(content);
  return openai.beta.threads.messages.create(threadId, {
    role: 'user',
    content,
  });
};

function getTheAnswerIsBeingGenerated() {
  return 'The answer is being generated …';
}

async function createThreadAndSayThatAnswerIsGenerated(message) {
  if (!message.channel?.isThread()) {
    if (message.hasThread) {
      const thread = await message.thread;
      await thread.send(getTheAnswerIsBeingGenerated());
      return thread;
    } else {
      let trimmedContent = message.content;
      if (trimmedContent.length > 60) {
        trimmedContent = trimmedContent.substring(0, 60) + '...';
      }
      // Create a new thread and send a message
      const thread = await message.startThread({
        name: trimmedContent,
        autoArchiveDuration: 60, // Dauer in Minuten, bis der Thread automatisch archiviert wird
      });
      await thread.send(getTheAnswerIsBeingGenerated());
      return thread;
    }
  } else {
    await message.reply(getTheAnswerIsBeingGenerated());
    return message.channel;
  }
}

async function sendReponseInChunksToDiscord(response, discordThread) {
  const chunkSize = 1999;
  let startIndex = 0;

  while (startIndex < response.length) {
    let endIndex = startIndex + chunkSize;

    // Adjust endIndex to not split at the mid of sentence or list
    if (endIndex < response.length) {
      while (
        response[endIndex] !== '.' &&
        response[endIndex] !== ',' &&
        endIndex > startIndex
      ) {
        endIndex--;
      }
    }

    const messageChunk = response.slice(startIndex, endIndex + 1);
    await discordThread.send(messageChunk);
    startIndex = endIndex + 1;
  }
}

// This event will run every time a message is received
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content || message.content === '') return; //Ignore bot messages
  // console.log(message);
  //

  //
  // console.log(openAiThreadId);

  console.log('message thread');
  const discordThread = await createThreadAndSayThatAnswerIsGenerated(message);
  const discordThreadId = discordThread.id;
  let openAiThreadId = getOpenAiThreadId(discordThreadId);

  let messagesLoaded = false;

  if (!openAiThreadId) {
    const thread = await openai.beta.threads.create();
    openAiThreadId = thread.id;
    addThreadToMap(discordThreadId, openAiThreadId);
    if (message.channel.isThread()) {
      //Gather all thread messages to fill out the OpenAI thread since we haven't seen this one yet
      const starterMsg = await message.channel.fetchStarterMessage();
      const otherMessagesRaw = await message.channel.messages.fetch();

      const otherMessages = Array.from(otherMessagesRaw.values())
        .map((msg) => msg.content)
        .reverse(); //oldest first

      const messages = [starterMsg.content, ...otherMessages].filter(
        (msg) => !!msg && msg !== '',
      );

      await Promise.all(messages.map((msg) => addMessage(openAiThreadId, msg)));
      messagesLoaded = true;
    }
  }

  if (!messagesLoaded) {
    //If this is for a thread, assume msg was loaded via .fetch() earlier
    await addMessage(openAiThreadId, message.content);
  }

  const run = await openai.beta.threads.runs.create(openAiThreadId, {
    assistant_id: process.env.ASSISTANT_ID,
  });
  const status = await statusCheckLoop(openAiThreadId, run.id);

  const messages = await openai.beta.threads.messages.list(openAiThreadId);
  let response = messages.data[0].content[0].text.value;
  await sendReponseInChunksToDiscord(response, discordThread);
});

// Authenticate Discord
client.login(process.env.DISCORD_TOKEN);
