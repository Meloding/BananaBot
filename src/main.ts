import QRCode from "qrcode";
import { WechatyBuilder } from "wechaty";
import { WechatCompanion } from "./companion.js";

// Wechaty instance
const weChatBot = WechatyBuilder.build({
  name: "my-wechat-bot",
});
// WechatCompanion instance
const companion = new WechatCompanion();

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
      companion.setBotName(user.name());
      await companion.startCompanion();
      companion.startReminderLoop(weChatBot);
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
        if (msgDate.getTime() <= companion.startTime.getTime()) {
          return;
        }
        console.log(`📨 ${message}`);
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
    console.error(`❌ Your Bot failed to start: ${e}`);
    console.log(
      "🤔 Can you login WeChat in browser? The bot works on the desktop WeChat"
    );
  }
}
main();
