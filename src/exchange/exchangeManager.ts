import * as ccxt from "ccxt";
import { ConfigLoader } from "../config/configLoader";
import { logger } from "../utils/logger";

/**
 * 交易所管理类，负责初始化连接和持仓模式设置
 */
export class ExchangeManager {
  private static instance: ExchangeManager;
  // CCXT Pro 的实例类型可以通过 InstanceType 获取，或者直接使用 any 简化
  public client: any;

  private constructor() {
    const config = ConfigLoader.getInstance().getConfig();
    const exchangeConfig = config.exchanges.find(e => e.name === "bitget");

    if (!exchangeConfig) {
      throw new Error("未在配置中找到 Bitget 交易所配置");
    }

    // 初始化 CCXT Pro 实例
    // 使用 new ccxt.pro.bitget() 创建实例
    this.client = new ccxt.pro.bitget({
      apiKey: exchangeConfig.apiKey,
      secret: exchangeConfig.secret,
      password: exchangeConfig.password,
      enableRateLimit: true,
      options: {
        defaultType: "swap", // 设置为合约模式
        adjustForTimeDifference: true,
        newUpdates: true, // 启用增量更新模式，这对 watchOrders 至关重要
        ...exchangeConfig.options,
      },
    });

    // 处理模拟盘 URL
    if (config.mode === "simulation") {
      this.client.setSandboxMode(true);
      logger.info("已开启 Bitget 模拟盘模式");
    }
  }

  public static getInstance(): ExchangeManager {
    if (!ExchangeManager.instance) {
      ExchangeManager.instance = new ExchangeManager();
    }
    return ExchangeManager.instance;
  }

  /**
   * 初始化连接，包括加载市场数据和设置双向持仓模式
   */
  public async initConnection(): Promise<void> {
    try {
      logger.info("正在连接 Bitget 交易所...");

      // 1. 加载市场
      await this.client.loadMarkets();
      logger.info("市场数据加载成功");

      // 2. 检查并设置持仓模式为双向持仓 (Hedge Mode)
      try {
        // Bitget setPositionMode(true) 为双向持仓
        await this.client.setPositionMode(true);
        logger.info("双向持仓模式 (Hedge Mode) 设置成功");
      } catch (e: any) {
        // 如果报错内容提示已经是该模式，则忽略
        if (
          e.message.includes("already") ||
          e.message.includes("not modified")
        ) {
          logger.info("持仓模式已经是双向持仓，无需修改");
        } else {
          logger.error(`设置持仓模式失败: ${e.message}`);
          throw e;
        }
      }

      // 3. 验证连接 (获取余额)
      const balance = await this.client.fetchBalance();
      logger.info(
        `账户连接成功，当前合约余额 (USDT): ${balance.total["USDT"] || 0}`
      );
    } catch (error: any) {
      logger.error(`交易所初始化失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取市场信息
   */
  public getMarket(symbol: string) {
    const market = this.client.market(symbol);
    if (!market) {
      throw new Error(`未找到交易对信息: ${symbol}`);
    }
    return market;
  }
}
