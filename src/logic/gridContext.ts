import * as fs from "fs";
import * as path from "path";
import { GridConfig, GridLevel } from "../types/grid";
import { logger } from "../utils/logger";

export class GridContext {
  private config: GridConfig;
  private levels: GridLevel[] = [];
  private csvPath: string;

  constructor(config: GridConfig) {
    this.config = config;
    // 生成 CSV 文件路径，处理 symbol 中的斜杠
    const safeSymbol = config.symbol.replace(/[/:]/g, "_");
    this.csvPath = path.join(
      process.cwd(),
      "temp",
      `grid_${safeSymbol}_${config.direction}.csv`
    );

    // 确保 temp 目录存在
    const tempDir = path.dirname(this.csvPath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  }

  /**
   * 初始化网格：计算刻度并保存/加载 CSV
   * @param tickSize 交易所的价格最小跳动单位 (例如 0.01)
   */
  public async initialize(tickSize: number): Promise<void> {
    if (fs.existsSync(this.csvPath)) {
      const isConfigMatched = this.checkConfigMatch();
      if (isConfigMatched) {
        logger.info(
          `[GridContext] 发现现有网格配置文件: ${this.csvPath} 且配置匹配，正在加载...`
        );
        this.loadFromCsv();
        return;
      } else {
        logger.warn(
          `[GridContext] 检测到配置已变更或 CSV 格式过旧，将重新生成网格: ${this.csvPath}`
        );
      }
    }

    logger.info(
      `[GridContext] 开始计算等比网格: ${this.config.symbol} ${this.config.direction}`
    );
    this.calculateLevels(tickSize);
    this.saveToCsv();
  }

  /**
   * 检查 CSV 中的配置元数据是否与当前配置匹配
   */
  private checkConfigMatch(): boolean {
    try {
      const content = fs.readFileSync(this.csvPath, "utf8");
      const firstLine = content.split("\n")[0];
      if (!firstLine.startsWith("# config:")) {
        return false;
      }

      const configStr = firstLine.replace("# config:", "");
      const [upper, lower, spread] = configStr.split(",").map(Number);

      return (
        upper === this.config.upperPrice &&
        lower === this.config.lowerPrice &&
        spread === this.config.gridSpread
      );
    } catch (error) {
      return false;
    }
  }

  /**
   * 计算等比网格刻度
   */
  private calculateLevels(tickSize: number): void {
    const { upperPrice, lowerPrice, gridSpread } = this.config;

    this.levels = [];
    let currentPrice = lowerPrice;
    let index = 0;

    // 辅助函数：将价格对齐到 Tick Size
    // 使用 Math.round 而不是 floor/ceil，确保最接近理论值
    const roundToTick = (p: number) => {
      const precision = 1 / tickSize;
      return Math.round(p * precision) / precision;
    };

    // 添加第一个刻度
    this.levels.push({
      index: index,
      price: roundToTick(currentPrice),
      buyOrderId: "",
      sellOrderId: "",
    });

    // 循环生成后续刻度，直到超过上限
    while (currentPrice < upperPrice) {
      index++;
      currentPrice = currentPrice * (1 + gridSpread);

      this.levels.push({
        index: index,
        price: roundToTick(currentPrice),
        buyOrderId: "",
        sellOrderId: "",
      });
    }
  }

  /**
   * 保存到 CSV
   */
  private saveToCsv(): void {
    const configMeta = `# config:${this.config.upperPrice},${this.config.lowerPrice},${this.config.gridSpread}\n`;
    const header = "index,price,buy_order_id,sell_order_id\n";
    const rows = this.levels
      .map(l => `${l.index},${l.price},${l.buyOrderId},${l.sellOrderId}`)
      .join("\n");
    fs.writeFileSync(this.csvPath, configMeta + header + rows, "utf8");
    logger.info(`[GridContext] 网格配置已保存至: ${this.csvPath}`);
  }

  /**
   * 从 CSV 加载
   */
  private loadFromCsv(): void {
    const content = fs.readFileSync(this.csvPath, "utf8");
    const allLines = content.trim().split("\n");
    // 过滤掉以 # 开头的注释行和 CSV 表头
    const dataLines = allLines.filter(
      line => !line.startsWith("#") && !line.startsWith("index,")
    );

    this.levels = dataLines.map(line => {
      const [index, price, buyOrderId, sellOrderId] = line.split(",");
      return {
        index: parseInt(index),
        price: parseFloat(price),
        buyOrderId: buyOrderId || "",
        sellOrderId: sellOrderId || "",
      };
    });
    logger.info(`[GridContext] 成功加载 ${this.levels.length} 个网格刻度`);
  }

  /**
   * 根据当前价格获取最近的两个网格刻度
   * @param currentPrice 当前市场价格
   * @returns [下边界刻度, 上边界刻度] | null
   */
  public getNearestLevels(currentPrice: number): [GridLevel, GridLevel] | null {
    if (this.levels.length < 2) return null;

    // 价格超出网格范围
    if (
      currentPrice >= this.config.upperPrice ||
      currentPrice <= this.config.lowerPrice
    ) {
      logger.warn(
        `[GridContext] 当前价格 ${currentPrice} 超出网格范围 [${this.config.lowerPrice}, ${this.config.upperPrice}]`
      );
      return null;
    }

    // 寻找当前价格所在的区间
    for (let i = 0; i < this.levels.length - 1; i++) {
      const lower = this.levels[i];
      const upper = this.levels[i + 1];
      if (currentPrice >= lower.price && currentPrice <= upper.price) {
        return [lower, upper];
      }
    }

    return null;
  }

  /**
   * 更新网格中的订单 ID 并持久化
   */
  public updateOrder(
    index: number,
    side: "buy" | "sell",
    orderId: string
  ): void {
    if (index >= 0 && index < this.levels.length) {
      if (side === "buy") {
        this.levels[index].buyOrderId = orderId;
      } else {
        this.levels[index].sellOrderId = orderId;
      }
      this.saveToCsv();
    }
  }

  public getLevels(): GridLevel[] {
    return this.levels;
  }

  public getConfig(): GridConfig {
    return this.config;
  }
}
