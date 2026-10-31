import postgres from "postgres";
import cfg from "./config.mjs";

export default postgres(cfg.sql);
