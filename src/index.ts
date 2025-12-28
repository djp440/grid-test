import { ConfigLoader } from "./config/configLoader";
import { logger } from "./utils/logger";
import { BotEngine } from "./logic/botEngine";

async function main() {
  try {
    logger.info("========================================");
    logger.info("   Bitget High-Frequency Grid Bot       ");
    logger.info("========================================");

    // 1. 加载配置
    const configLoader = ConfigLoader.getInstance();
    configLoader.loadConfig();

    // 2. 启动机器人引擎
    const engine = new BotEngine();

    // 捕获进程信号以优雅退出
    process.on("SIGINT", async () => {
      logger.info("[Main] 接收到 SIGINT 信号，正在停止机器人...");
      await engine.stop();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      logger.info("[Main] 接收到 SIGTERM 信号，正在停止机器人...");
      await engine.stop();
      process.exit(0);
    });

    // 3. 运行引擎
    await engine.start();
  } catch (error: any) {
    logger.error("程序启动时发生致命错误:", error);
    process.exit(1);
  }
}

main();
