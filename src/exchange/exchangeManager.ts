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

  /**
   * 获取价格最小跳动单位 (Tick Size)
   */
  public getTickSize(symbol: string): number {
    const market = this.getMarket(symbol);
    // CCXT 的 precision.price 可能是小数 (tickSize) 也可能是整数 (decimals)
    // 取决于 precisionMode。但通常 safe way 是看 precision.price
    // 如果是 bitget，通常是小数形式的 tickSize
    // 为了稳健，我们可以检查一下
    const pricePrecision = market.precision.price;

    if (typeof pricePrecision === "number") {
      const mode = this.client.precisionMode;
      // CCXT constants are not exported in types, so we cast or use values
      // TICK_SIZE = 4, DECIMAL_PLACES = 2, SIGNIFICANT_DIGITS = 3
      if (mode === (ccxt as any).TICK_SIZE) {
        return pricePrecision;
      } else if (mode === (ccxt as any).DECIMAL_PLACES) {
        return Math.pow(10, -pricePrecision);
      } else if (mode === (ccxt as any).SIGNIFICANT_DIGITS) {
        // 这种情况比较少见用于 crypto spot/swap price
        return 0.00000001; // Fallback
      }
    }

    // 如果上面都没匹配，尝试直接读 info (Bitget 原生字段)
    if (market.info && market.info.pricePlace) {
      // Bitget v1
      return Math.pow(10, -parseInt(market.info.pricePlace));
    }

    // Fallback default
    return 0.00000001;
  }
}
