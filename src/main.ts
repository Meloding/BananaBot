import QRCode from "qrcode";
import { WechatyBuilder } from "wechaty";
import { ChatGPTBot } from "./chatgpt.js";

// Wechaty instance
const weChatBot = WechatyBuilder.build({
  name: "my-wechat-bot",
});
// ChatGPTBot instance
const chatGPTBot = new ChatGPTBot();

async function main() {
  weChatBot
    // scan QR code for login
    .on("scan", async (qrcode, status) => {
      const url = `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`;
      console.log(`💡 Scan QR Code in WeChat to login: ${status}\n${url}`);
      console.log(
        await QRCode.toString(qrcode, { type: "terminal", small: true })
      );
    })
    // login to WeChat desktop account
    .on("login", async (user: any) => {
      console.log(`✅ User ${user} has logged in`);
      chatGPTBot.setBotName(user.name());
      await chatGPTBot.startGPTBot();
      chatGPTBot.startReminderLoop(weChatBot);
    })
    // keep recoverable puppet errors from crashing the process
    .on("error", (error: any) => {
      console.error(`❌ Wechaty error: ${error?.stack || error}`);
    })
    // message handler
    .on("message", async (message: any) => {
      try {
        // prevent accidentally respond to history chat on restart
        // only respond to message later than chatbot start time
        const msgDate = message.date();
        if (msgDate.getTime() <= chatGPTBot.startTime.getTime()) {
          return;
        }
        console.log(`📨 ${message}`);
        // handle message for customized task handlers
        const handled = await chatGPTBot.onCustimzedTask(message);
        if (handled) {
          return;
        }
        // handle message for chatGPT bot
        await chatGPTBot.onMessage(message);
      } catch (e) {
        console.error(`❌ ${e}`);
      }
    });

  try {
    await weChatBot.start();
  } catch (e) {
    console.error(`❌ Your Bot failed to start: ${e}`);
    console.log(
      "🤔 Can you login WeChat in browser? The bot works on the desktop WeChat"
    );
  }
}
main();
