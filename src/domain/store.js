/**
 * 事件存储。
 *
 * 两条硬规则：
 * 1. event_id 全局唯一——供应方重复回调携带同一 event_id 时第二次必被拒绝，
 *    因此不会产生二次占位或二次退款；
 * 2. 每个聚合流内 version 从 1 连续递增，append 时校验 expectedVersion（乐观锁）。
 *
 * 生产实现可把 append 换成数据库事务（events 表对 event_id 建唯一索引、
 * 对流+version 建唯一索引）；领域层只依赖这里的接口。
 */
export class EventStore {
  #streams = new Map(); // key -> event[]
  #seenEventIds = new Set();
  #listeners = new Set();

  static streamKey(aggregateType, aggregateId) {
    return `${aggregateType}:${aggregateId}`;
  }

  load(aggregateType, aggregateId) {
    return this.#streams.get(EventStore.streamKey(aggregateType, aggregateId))?.slice() ?? [];
  }

  streamVersion(aggregateType, aggregateId) {
    return this.load(aggregateType, aggregateId).length;
  }

  /**
   * @param {object} event 已含 event_id、event_type、aggregate 字段与 version 的完整事件
   * @param {number} [expectedVersion] 期望的追加前版本；不传则不校验（新建流时传 0）
   */
  append(event, expectedVersion) {
    if (!event || typeof event !== "object") throw new Error("事件不能为空");
    if (this.#seenEventIds.has(event.event_id)) {
      const err = new Error(`event_id 重复，拒绝追加：${event.event_id}`);
      err.code = "DUPLICATE_EVENT";
      throw err;
    }
    const key = EventStore.streamKey(event.aggregate_type, event.aggregate_id);
    const stream = this.#streams.get(key) ?? [];
    if (expectedVersion !== undefined && stream.length !== expectedVersion) {
      const err = new Error(
        `并发修改：流 ${key} 当前版本 ${stream.length}，期望 ${expectedVersion}`
      );
      err.code = "VERSION_CONFLICT";
      throw err;
    }
    if (event.version !== stream.length + 1) {
      const err = new Error(`版本不连续：流 ${key} 下一版本应为 ${stream.length + 1}，收到 ${event.version}`);
      err.code = "VERSION_GAP";
      throw err;
    }
    const stored = { ...event };
    stream.push(stored);
    this.#streams.set(key, stream);
    this.#seenEventIds.add(stored.event_id);
    for (const listener of this.#listeners) {
      try {
        listener(stored);
      } catch {
        // 监听器失败不影响提交；投影应由订阅方自行容错/重放
      }
    }
    return stored;
  }

  /** 是否已处理过某 event_id（回调入口先查这里）。 */
  hasEvent(eventId) {
    return this.#seenEventIds.has(eventId);
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  allEvents() {
    return [...this.#streams.values()].flat().sort((a, b) =>
      a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0
    );
  }
}
