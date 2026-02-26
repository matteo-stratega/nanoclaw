import { Bot } from "grammy";

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from "../config.js";
import { logger } from "../logger.js";
import { transcribeAudio } from "../transcribe.js";
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup, NewMessage } from "../types.js";

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface StaffBot {
  bot: Bot;
  jid: string; // The chat JID this bot serves
  name: string; // Display name (e.g., "Dwight")
}

export class TelegramChannel implements Channel {
  name = "telegram";
  prefixAssistantName = false; // Telegram bots already display their name

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private staffBots: Map<string, StaffBot> = new Map(); // JID → StaffBot

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);
    this.setupBotHandlers(this.bot, false);

    // Start polling
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            "Telegram bot connected",
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  /**
   * Start a dedicated staff bot for a registered group.
   * The staff bot only handles messages from its assigned chat JID.
   */
  async startStaffBot(jid: string, token: string, name: string): Promise<void> {
    // Don't start duplicates
    if (this.staffBots.has(jid)) {
      logger.debug({ jid, name }, "Staff bot already running");
      return;
    }

    const bot = new Bot(token);
    this.setupBotHandlers(bot, true);

    const staffBot: StaffBot = { bot, jid, name };

    return new Promise<void>((resolve, reject) => {
      bot.start({
        onStart: (botInfo) => {
          this.staffBots.set(jid, staffBot);
          logger.info(
            { username: botInfo.username, id: botInfo.id, jid, name },
            "Staff bot connected",
          );
          console.log(`  Staff bot: @${botInfo.username} → ${name} (${jid})`);
          resolve();
        },
      });

      // Timeout after 15s
      setTimeout(() => {
        if (!this.staffBots.has(jid)) {
          reject(new Error(`Staff bot ${name} failed to start within 15s`));
        }
      }, 15000);
    });
  }

  /**
   * Stop a staff bot.
   */
  async stopStaffBot(jid: string): Promise<void> {
    const staffBot = this.staffBots.get(jid);
    if (staffBot) {
      staffBot.bot.stop();
      this.staffBots.delete(jid);
      logger.info({ jid, name: staffBot.name }, "Staff bot stopped");
    }
  }

  /**
   * Get all active staff bot JIDs.
   */
  getActiveStaffBotJids(): string[] {
    return Array.from(this.staffBots.keys());
  }

  /**
   * Set up message handlers on a bot instance.
   * Used for both the main bot and staff bots.
   */
  private setupBotHandlers(bot: Bot, isStaffBot: boolean): void {
    // Command to get chat ID (useful for registration)
    bot.command("chatid", (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === "private"
          ? ctx.from?.first_name || "Private"
          : (ctx.chat as any).title || "Unknown";

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: "Markdown" },
      );
    });

    // Command to check bot status
    bot.command("ping", (ctx) => {
      const botName = isStaffBot ? "Staff agent" : ASSISTANT_NAME;
      ctx.reply(`${botName} is online.`);
    });

    bot.on("message:text", async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith("/")) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        "Unknown";
      const sender = ctx.from?.id.toString() || "";
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === "private"
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === "mention") {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          "Message from unregistered Telegram chat",
        );
        return;
      }

      // For staff bots: treat all messages as no-trigger (private chats, always respond)
      // The trigger check happens in processGroupMessages anyway
      if (isStaffBot) {
        // Staff bots always respond — override trigger requirement
        // We inject a synthetic trigger if the content doesn't already have one
        if (!TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, isStaffBot },
        "Telegram message stored",
      );
    });

    // Handle non-text messages with placeholders
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : "";

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || "",
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    bot.on("message:photo", (ctx) => storeNonText(ctx, "[Photo]"));
    bot.on("message:video", (ctx) => storeNonText(ctx, "[Video]"));
    bot.on("message:voice", async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Use the correct bot token for voice file download
      const tokenForDownload = this.getTokenForJid(chatJid);

      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${tokenForDownload}/${file.file_path}`;
        const res = await fetch(url);
        const buffer = Buffer.from(await res.arrayBuffer());
        const text = await transcribeAudio(buffer);
        if (text) {
          const timestamp = new Date(ctx.message.date * 1000).toISOString();
          const senderName = ctx.from?.first_name || ctx.from?.username || "Unknown";
          this.opts.onChatMetadata(chatJid, timestamp);

          let content = `[Voice] ${text}`;
          // Staff bots: inject trigger for voice messages too
          if (isStaffBot && !TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }

          this.opts.onMessage(chatJid, {
            id: ctx.message.message_id.toString(),
            chat_jid: chatJid,
            sender: ctx.from?.id?.toString() || "",
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: false,
          });
          logger.info({ chatJid, chars: text.length }, "Voice message transcribed");
          return;
        }
      } catch (err) {
        logger.error({ err }, "Voice transcription failed, falling back to placeholder");
      }
      storeNonText(ctx, "[Voice message]");
    });
    bot.on("message:audio", (ctx) => storeNonText(ctx, "[Audio]"));
    bot.on("message:document", (ctx) => {
      const name = ctx.message.document?.file_name || "file";
      storeNonText(ctx, `[Document: ${name}]`);
    });
    bot.on("message:sticker", (ctx) => {
      const emoji = ctx.message.sticker?.emoji || "";
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    bot.on("message:location", (ctx) => storeNonText(ctx, "[Location]"));
    bot.on("message:contact", (ctx) => storeNonText(ctx, "[Contact]"));

    // Handle errors gracefully
    bot.catch((err) => {
      logger.error({ err: err.message, isStaffBot }, "Telegram bot error");
    });
  }

  /**
   * Get the bot token for a given JID.
   * Staff bots use their own token, everything else uses the main bot token.
   */
  private getTokenForJid(jid: string): string {
    const staffBot = this.staffBots.get(jid);
    return staffBot ? this.getStaffBotToken(jid) : this.botToken;
  }

  /**
   * Get a staff bot's token from the Bot instance.
   * Grammy stores the token internally — we retrieve it from registered groups.
   */
  private getStaffBotToken(jid: string): string {
    const group = this.opts.registeredGroups()[jid];
    return group?.botToken || this.botToken;
  }

  /**
   * Get the correct Bot API instance for a JID.
   * Routes through staff bot if one exists, otherwise uses main bot.
   */
  private getBotForJid(jid: string): Bot | null {
    const staffBot = this.staffBots.get(jid);
    if (staffBot) return staffBot.bot;
    return this.bot;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const bot = this.getBotForJid(jid);
    if (!bot) {
      logger.warn({ jid }, "No bot available for JID");
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, "");

      // Telegram has a 4096 character limit per message
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }

      const isStaff = this.staffBots.has(jid);
      logger.info({ jid, length: text.length, isStaff }, "Telegram message sent");
    } catch (err) {
      logger.error({ jid, err }, "Failed to send Telegram message");
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith("tg:");
  }

  async disconnect(): Promise<void> {
    // Stop all staff bots first
    for (const [jid, staffBot] of this.staffBots) {
      staffBot.bot.stop();
      logger.info({ jid, name: staffBot.name }, "Staff bot stopped");
    }
    this.staffBots.clear();

    // Stop main bot
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info("Telegram bot stopped");
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const bot = this.getBotForJid(jid);
    if (!bot) return;
    try {
      const numericId = jid.replace(/^tg:/, "");
      await bot.api.sendChatAction(numericId, "typing");
    } catch (err) {
      logger.debug({ jid, err }, "Failed to send Telegram typing indicator");
    }
  }
}
