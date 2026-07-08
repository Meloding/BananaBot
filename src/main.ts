import QRCode from "qrcode";
import { WechatyBuilder } from "wechaty";
import { WechatCompanion } from "./companion.js";
import { botStatus, startStatusServer } from "./status-server.js";

// Wechaty instance
const weChatBot = WechatyBuilder.build({
  name: "my-wechat-bot",
});
// WechatCompanion instance
const companion = new WechatCompanion();

async function main() {
  startStatusServer();
  botStatus.update({ wechatState: "starting" });

  weChatBot
    // scan QR code for login
    .on("scan", async (qrcode, status) => {
      const url = `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`;
      botStatus.markScan(String(status));
      console.log(`💡 Scan QR Code in WeChat to login: ${status}\n${url}`);
      console.log(
        await QRCode.toString(qrcode, { type: "terminal", small: true })
      );
    })
    // login to WeChat desktop account
    .on("login", async (user: any) => {
      console.log(`✅ User ${user} has logged in`);
      companion.setBotName(user.name());
      await companion.startCompanion();
      botStatus.markLogin(user.name());
      companion.startReminderLoop(weChatBot);
    })
    .on("logout", (user: any) => {
      const userName = user?.name?.() || String(user || "");
      console.log(`👋 User ${userName} has logged out`);
      botStatus.markLogout(userName);
    })
    // keep recoverable puppet errors from crashing the process
    .on("error", (error: any) => {
      botStatus.recordError(error);
      console.error(`❌ Wechaty error: ${error?.stack || error}`);
    })
    // message handler
    .on("message", async (message: any) => {
      try {
        // prevent accidentally respond to history chat on restart
        // only respond to message later than chatbot start time
        const msgDate = message.date();
        if (msgDate.getTime() <= companion.startTime.getTime()) {
          return;
        }
        console.log(`📨 ${message}`);
        await botStatus.recordIncomingMessage(message);
        // handle message for customized task handlers
        const handled = await companion.onCustimzedTask(message);
        if (handled) {
          return;
        }
        // handle message for companion bot
        await companion.onMessage(message);
      } catch (e) {
        console.error(`❌ ${e}`);
      }
    });

  try {
    await weChatBot.start();
  } catch (e) {
    botStatus.recordError(e);
    console.error(`❌ Your Bot failed to start: ${e}`);
    console.log(
      "🤔 Can you login WeChat in browser? The bot works on the desktop WeChat"
    );
  }
}
main();
