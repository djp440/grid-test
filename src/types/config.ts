import { GridConfig } from "./grid";

export interface ExchangeConfig {
  name: string;
  enable: boolean;
  apiKey?: string;
  secret?: string;
  password?: string;
  options?: Record<string, any>;
}

export interface LoggerConfig {
  level: string;
  console: boolean;
  file: boolean;
  dir: string;
}

export interface MonitorConfig {
  interval_seconds: number;
}

export interface DefaultGridConfig {
  leverage: number;
  order_window: number; // 挂单窗口大小 (上下各挂几单)
  follow_market_on_fill: boolean; // 成交后是否以最新市价重新定位锚点
  cancel_all_on_stop: boolean; // 关闭程序时是否取消所有挂单
  close_all_on_stop: boolean; // 关闭程序时是否平掉所有仓位
  auto_initial_position?: boolean; // 是否自动计算并市价建仓
}

export interface AppConfig {
  mode: "real" | "simulation";
  logger: LoggerConfig;
  monitor?: MonitorConfig;
  default: DefaultGridConfig;
  exchanges: ExchangeConfig[];
  strategies: GridConfig[];
}
