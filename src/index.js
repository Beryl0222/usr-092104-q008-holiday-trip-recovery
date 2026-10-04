/**
 * 假期联程保障协商后端 —— 统一装配入口。
 */
export { EventStore } from "./domain/store.js";
export {
  REDUCERS,
  loadAggregate,
  reduceTravelParty,
  reduceBookingSegment,
  reduceRecoveryOption,
  reduceFinancialResolution,
} from "./domain/aggregates.js";
export { planRecovery, canStillUse, DEFAULT_MCT_MINUTES } from "./domain/planner.js";
export * from "./domain/time.js";
export { membersBlockedOnDocuments, documentSatisfies } from "./domain/documents.js";
export { RecoveryService } from "./application/service.js";
export { customerExplanation, agentDashboard, disputeTrail, timeline } from "./application/queries.js";
export { SupplierGateway, SupplierError } from "./suppliers/gateway.js";
export { createServer } from "./http/server.js";
export { validateEvent } from "./validator.js";
export { EVENT_TYPES, AGGREGATE_TYPES, SEGMENT_KINDS, SUPPLIER_STATUSES, ACTIONS, OPTION_STATUSES } from "./contracts.js";
