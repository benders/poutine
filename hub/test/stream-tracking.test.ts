     1|import { describe, it, expect, beforeEach, afterEach } from "vitest";
     2|import Database from "better-sqlite3";
     3|import path from "node:path";
     4|import os from "node:os";
     5|import fs from "node:fs";
     6|import { StreamTrackingService } from "../src/services/stream-tracking.js";
     7|
     8|function tmpDbPath() {
     9|  return path.join(
    10|    os.tmpdir(),
    11|    `poutine-stream-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    12|  );
    13|}
    14|
    15|describe("StreamTrackingService", () => {
    16|  let db: Database.Database;
    17|  let service: StreamTrackingService;
    18|  let dbPath: string;
    19|
    20|  beforeEach(() => {
    21|    dbPath = tmpDbPath();
    22|    db = new Database(dbPath);
    23|    
    24|    // Create the stream_operations table
    25|    db.exec(`
    26|      CREATE TABLE stream_operations (
    27|        id TEXT PRIMARY KEY,
    28|        username TEXT NOT NULL,
    29|        track_id TEXT NOT NULL,
    30|        track_title TEXT NOT NULL,
    31|        artist_name TEXT NOT NULL,
    32|        started_at TEXT NOT NULL,
    33|        finished_at TEXT,
    34|        duration_ms INTEGER,
    35|        bytes_transferred INTEGER
    36|      )
    37|    `);
    38|    
    39|    service = new StreamTrackingService(db);
    40|  });
    41|
    42|  afterEach(() => {
    43|    db.close();
    44|    if (fs.existsSync(dbPath)) {
    45|      fs.unlinkSync(dbPath);
    46|    }
    47|  });
    48|
    49|  describe("start", () => {
    50|    it("should create a new stream operation and track it as active", () => {
    51|      const id = service.start("alice", "t:123", "Bohemian Rhapsody", "Queen");
    52|      
    53|      expect(id).toBeTruthy();
    54|      expect(id).toHaveLength(36); // UUID format
    55|      
    56|      // Check database
    57|      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id);
    58|      expect(row).toBeTruthy();
    59|      expect((row as any).username).toBe("alice");
    60|      expect((row as any).track_id).toBe("t:123");
    61|      expect((row as any).track_title).toBe("Bohemian Rhapsody");
    62|      expect((row as any).artist_name).toBe("Queen");
    63|      expect((row as any).started_at).toBeTruthy();
    64|      
    65|      // Check active tracking
    66|      const active = service.getActive();
    67|      expect(active).toHaveLength(1);
    68|      expect(active[0].id).toBe(id);
    69|    });
    70|
    71|    it("should handle multiple concurrent streams", () => {
    72|      const id1 = service.start("alice", "t:1", "Song 1", "Artist 1");
    73|      const id2 = service.start("bob", "t:2", "Song 2", "Artist 2");
    74|      const id3 = service.start("charlie", "t:3", "Song 3", "Artist 3");
    75|      
    76|      const active = service.getActive();
    77|      
    78|      expect(active).toHaveLength(3);
    79|      const activeIds = active.map((a) => a.id);
    80|      expect(activeIds).toContain(id1);
    81|      expect(activeIds).toContain(id2);
    82|      expect(activeIds).toContain(id3);
    83|    });
    84|
    85|    it("should return the active stream count", () => {
    86|      service.start("alice", "t:1", "Song 1", "Artist 1");
    87|      service.start("bob", "t:2", "Song 2", "Artist 2");
    88|      
    89|      expect(service.getActiveCount()).toBe(2);
    90|    });
    91|  });
    92|
    93|  describe("finish", () => {
    94|    it("should mark a stream as finished with duration and bytes", () => {
    95|      const id = service.start("alice", "t:123", "Bohemian Rhapsody", "Queen");
    96|      
    97|      service.finish(id, 354000, 8500000); // 5:54 duration, ~8.5MB
    98|      
    99|      // Check database
   100|      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id);
   101|      expect((row as any).finished_at).toBeTruthy();
   102|      expect((row as any).duration_ms).toBe(354000);
   103|      expect((row as any).bytes_transferred).toBe(8500000);
   104|      
   105|      // Check it's no longer active
   106|      const active = service.getActive();
   107|      expect(active).toHaveLength(0);
   108|    });
   109|
   110|    it("should handle streams finished without duration", () => {
   111|      const id = service.start("alice", "t:123", "Song", "Artist");
   112|      
   113|      service.finish(id, null, 5000000);
   114|      
   115|      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id);
   116|      expect((row as any).duration_ms).toBeNull();
   117|      expect((row as any).bytes_transferred).toBe(5000000);
   118|    });
   119|
   120|    it("should handle streams finished without bytes transferred", () => {
   121|      const id = service.start("alice", "t:123", "Song", "Artist");
   122|      
   123|      service.finish(id, 180000, null);
   124|      
   125|      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id);
   126|      expect((row as any).duration_ms).toBe(180000);
   127|      expect((row as any).bytes_transferred).toBeNull();
   128|    });
   129|
   130|    it("should remove stream from active tracking on finish", () => {
   131|      const id1 = service.start("alice", "t:1", "Song 1", "Artist 1");
   132|      const id2 = service.start("bob", "t:2", "Song 2", "Artist 2");
   133|      
   134|      service.finish(id1, 180000, 5000000);
   135|      
   136|      expect(service.getActiveCount()).toBe(1);
   137|      
   138|      const active = service.getActive();
   139|      expect(active[0].id).toBe(id2);
   140|    });
   141|  });
   142|
   143|  describe("getActive", () => {
   144|    it("should return all currently active streams", () => {
   145|      service.start("alice", "t:1", "Song 1", "Artist 1");
   146|      service.start("bob", "t:2", "Song 2", "Artist 2");
   147|      
   148|      const active = service.getActive();
   149|      
   150|      expect(active).toHaveLength(2);
   151|      expect(active[0].durationMs).toBeNull(); // Still playing
   152|      expect(active[1].durationMs).toBeNull();
   153|    });
   154|
   155|    it("should not include finished streams", () => {
   156|      const id1 = service.start("alice", "t:1", "Song 1", "Artist 1");
   157|      service.start("bob", "t:2", "Song 2", "Artist 2");
   158|      
   159|      service.finish(id1, 180000, 5000000);
   160|      
   161|      const active = service.getActive();
   162|      
   163|      expect(active).toHaveLength(1);
   164|      expect(active[0].trackTitle).toBe("Song 2");
   165|    });
   166|  });
   167|
   168|  describe("getRecent", () => {
   169|    it("should return operations ordered by started_at descending", () => {
   170|      const id1 = service.start("alice", "t:1", "Song 1", "Artist 1");
   171|      service.finish(id1, 180000, 5000000);
   172|      
   173|      const id2 = service.start("bob", "t:2", "Song 2", "Artist 2");
   174|      service.finish(id2, 240000, 7000000);
   175|      
   176|      const recent = service.getRecent(10);
   177|      
   178|      expect(recent).toHaveLength(2);
   179|      expect(recent[0].id).toBe(id2); // Most recent first
   180|      expect(recent[1].id).toBe(id1);
   181|    });
   182|
   183|    it("should respect the limit parameter", () => {
   184|      // Create 5 streams
   185|      const ids: string[] = [];
   186|      for (let i = 0; i < 5; i++) {
   187|        const id = service.start(`user${i}`, `t:${i}`, `Song ${i}`, `Artist ${i}`);
   188|        service.finish(id, 180000, 5000000);
   189|        ids.push(id);
   190|      }
   191|      
   192|      const recent = service.getRecent(3);
   193|      
   194|      expect(recent).toHaveLength(3);
   195|    });
   196|
   197|    it("should include all stream metadata", () => {
   198|      const id = service.start("alice", "t:123", "Bohemian Rhapsody", "Queen");
   199|      service.finish(id, 354000, 8500000);
   200|      
   201|      const recent = service.getRecent(10);
   202|      
   203|      expect(recent[0]).toMatchObject({
   204|        id,
   205|        username: "alice",
   206|        trackId: "t:123",
   207|        trackTitle: "Bohemian Rhapsody",
   208|        artistName: "Queen",
   209|        durationMs: 354000,
   210|        bytesTransferred: 8500000,
   211|      });
   212|      expect(recent[0].startedAt).toBeTruthy();
   213|      expect(recent[0].finishedAt).toBeTruthy();
   214|    });
   215|  });
   216|
   217|  describe("clearAll", () => {
   218|    it("should delete all stream history and clear active tracking", () => {
   219|      const id1 = service.start("alice", "t:1", "Song 1", "Artist 1");
   220|      const id2 = service.start("bob", "t:2", "Song 2", "Artist 2");
   221|      service.finish(id1, 180000, 5000000);
   222|      
   223|      service.clearAll();
   224|      
   225|      const recent = service.getRecent(100);
   226|      expect(recent).toHaveLength(0);
   227|      expect(service.getActiveCount()).toBe(0);
   228|    });
   229|  });
   230|
   231|  describe("integration", () => {
   232|    it("should track a complete stream lifecycle", () => {
   233|      // Start stream
   234|      const streamId = service.start("alice", "t:123", "Bohemian Rhapsody", "Queen");
   235|      
   236|      // Verify it's active
   237|      expect(service.getActiveCount()).toBe(1);
   238|      
   239|      // Finish stream
   240|      service.finish(streamId, 354000, 8500000);
   241|      
   242|      // Verify history
   243|      const recent = service.getRecent(10);
   244|      expect(recent).toHaveLength(1);
   245|      expect(recent[0]).toMatchObject({
   246|        id: streamId,
   247|        username: "alice",
   248|        trackTitle: "Bohemian Rhapsody",
   249|        artistName: "Queen",
   250|        durationMs: 354000,
   251|        bytesTransferred: 8500000,
   252|      });
   253|      
   254|      // Verify no longer active
   255|      expect(service.getActiveCount()).toBe(0);
   256|    });
   257|
   258|    it("should handle multiple users streaming concurrently", () => {
   259|      const streams: { id: string; user: string }[] = [];
   260|      
   261|      // Start 3 concurrent streams
   262|      streams.push({ id: service.start("alice", "t:1", "Song A", "Artist A"), user: "alice" });
   263|      streams.push({ id: service.start("bob", "t:2", "Song B", "Artist B"), user: "bob" });
   264|      streams.push({ id: service.start("charlie", "t:3", "Song C", "Artist C"), user: "charlie" });
   265|      
   266|      expect(service.getActiveCount()).toBe(3);
   267|      
   268|      // Finish first stream
   269|      service.finish(streams[0].id, 200000, 6000000);
   270|      
   271|      expect(service.getActiveCount()).toBe(2);
   272|      
   273|      // Finish remaining streams
   274|      service.finish(streams[1].id, 180000, 5000000);
   275|      service.finish(streams[2].id, 240000, 7000000);
   276|      
   277|      expect(service.getActiveCount()).toBe(0);
   278|      
   279|      // Verify all in history
   280|      const recent = service.getRecent(10);
   281|      expect(recent).toHaveLength(3);
   282|      
   283|      // Verify each stream's data
   284|      const aliceStream = recent.find((s) => s.username === "alice");
   285|      const bobStream = recent.find((s) => s.username === "bob");
   286|      const charlieStream = recent.find((s) => s.username === "charlie");
   287|      
   288|      expect(aliceStream).toMatchObject({ trackTitle: "Song A", artistName: "Artist A" });
   289|      expect(bobStream).toMatchObject({ trackTitle: "Song B", artistName: "Artist B" });
   290|      expect(charlieStream).toMatchObject({ trackTitle: "Song C", artistName: "Artist C" });
   291|    });
   292|
   293|    it("should track stream with realistic audio data", () => {
   294|      // Simulate a 3-minute 45-second FLAC track at ~900kbps
   295|      const streamId = service.start("music_lover", "t:42", "Dark Side of the Moon", "Pink Floyd");
   296|      
   297|      // 3:45 = 225 seconds
   298|      const durationMs = 225000;
   299|      // ~900kbps * 225 seconds = ~25MB
   300|      const bytesTransferred = 25300000;
   301|      
   302|      service.finish(streamId, durationMs, bytesTransferred);
   303|      
   304|      const recent = service.getRecent(10);
   305|      expect(recent[0]).toMatchObject({
   306|        trackTitle: "Dark Side of the Moon",
   307|        artistName: "Pink Floyd",
   308|        durationMs: 225000,
   309|        bytesTransferred: 25300000,
   310|      });
   311|    });
   312|  });
   313|});
   314|