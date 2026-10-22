import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import type { ProducerConfig } from "./producer";

const { mockCaptureError, mockLogWarn } = vi.hoisted(() => ({
	mockCaptureError: vi.fn(),
	mockLogWarn: vi.fn(),
}));

vi.mock("evlog", async () => {
	const actual = await vi.importActual<typeof import("evlog")>("evlog");
	return { ...actual, log: { ...actual.log, warn: mockLogWarn } };
});

vi.mock("@databuddy/db/clickhouse", async (importOriginal) => ({
	...(await importOriginal<typeof import("@databuddy/db/clickhouse")>()),
	clickHouse: {},
}));

vi.mock("@lib/tracing", () => ({
	captureError: mockCaptureError,
	record: <T>(_name: string, fn: () => Promise<T>) => fn(),
}));

const { createEventProducer, TOPIC_MAP } = await import("./producer");

const topicMap = {
	"analytics-blocked-traffic": "analytics.blocked_traffic",
	"analytics-custom-events": "analytics.custom_events",
	"analytics-events": "analytics.events",
};

const baseConfig: ProducerConfig = {
	chunkSize: 100,
	connectTimeout: 100,
	directFallbackTimeout: 1000,
	healthProbeTimeout: 100,
	kafkaTimeout: 1000,
	lingerMs: 0,
	maxBatchBytes: 512 * 1024,
	maxBatchMessages: 500,
	maxProducerRetries: 0,
	maxQueuedMessages: 1000,
	producerRetryDelay: 1,
	reconnectCooldown: 1,
	selfHost: true,
	shutdownDrainTimeout: 50,
};

const withKafka: Partial<ProducerConfig> = {
	broker: "redpanda.test:9092",
	reconnectCooldown: 60_000,
	selfHost: false,
};

const run = Effect.runPromise;

const event = (id: string) => ({
	client_id: "ws_1",
	event_id: id,
	timestamp: 1,
});

const cluster = {
	brokers: [{ host: "redpanda.test", nodeId: 1, port: 9092 }],
	clusterId: "test",
	controller: 1,
};

const settlesWithin = (promise: Promise<void>, ms: number) =>
	Promise.race([
		promise.then(
			() => true,
			() => true
		),
		new Promise<boolean>((resolve) => setTimeout(resolve, ms, false)),
	]);

function deferred<T = void>() {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: Error) => void = () => undefined;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, reject, resolve };
}

function fakeKafka(overrides: Partial<Record<"connect" | "send", Mock>> = {}) {
	return {
		connect: vi.fn(() => Promise.resolve()),
		disconnect: vi.fn(() => Promise.resolve()),
		send: vi.fn(() => Promise.resolve([])),
		...overrides,
	};
}

function fakeAdmin(
	overrides: Partial<
		Record<"describeCluster" | "disconnect" | "listTopics", Mock>
	> = {}
) {
	return {
		connect: vi.fn(() => Promise.resolve()),
		describeCluster: vi.fn(() => Promise.resolve(cluster)),
		disconnect: vi.fn(() => Promise.resolve()),
		listTopics: vi.fn(() => Promise.resolve(Object.keys(topicMap))),
		...overrides,
	};
}

function createProducer({
	config = {},
	insert = vi.fn(() => Promise.resolve()),
	kafka,
	kafkaAdmin,
}: {
	config?: Partial<ProducerConfig>;
	insert?: Mock;
	kafka?: ReturnType<typeof fakeKafka>;
	kafkaAdmin?: ReturnType<typeof fakeAdmin>;
} = {}) {
	return createEventProducer({
		clickHouse: { insert },
		config: { ...baseConfig, ...config },
		kafka,
		kafkaAdmin,
		topicMap,
	});
}

const sentBatches = (send: Mock) =>
	send.mock.calls.map((call) =>
		(call[0] as { messages: { value: string }[] }).messages.map(
			(message) => (JSON.parse(message.value) as { event_id: string }).event_id
		)
	);

const sentMessageCount = (send: Mock) =>
	sentBatches(send).reduce((total, batch) => total + batch.length, 0);

const insertedToken = (insert: Mock, call: number) =>
	(
		insert.mock.calls[call]?.[0] as {
			clickhouse_settings?: { insert_deduplication_token?: string };
		}
	).clickhouse_settings?.insert_deduplication_token;

beforeEach(() => {
	mockCaptureError.mockClear();
	mockLogWarn.mockClear();
});

describe("direct ClickHouse delivery", () => {
	test("acknowledges only after the insert succeeds, even with a broker configured for self-hosting", async () => {
		const insertDone = deferred();
		const insert = vi.fn(() => insertDone.promise);
		const kafka = fakeKafka();
		const producer = createProducer({
			config: { broker: "redpanda.test:9092" },
			insert,
			kafka,
		});

		let acknowledged = false;
		const delivery = run(
			producer.sendOne("analytics-events", event("e1"))
		).then(() => {
			acknowledged = true;
		});
		await vi.waitFor(() => expect(insert).toHaveBeenCalledOnce());
		expect(acknowledged).toBe(false);
		insertDone.resolve();
		await delivery;

		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				clickhouse_settings: {
					async_insert: 1,
					wait_for_async_insert: 1,
					async_insert_busy_timeout_ms: 2000,
					insert_deduplication_token: expect.stringMatching(/^[\da-f]{64}$/),
				},
				format: "JSONEachRow",
				query_id: expect.stringMatching(/^basket-[\da-f]{64}$/),
				table: "analytics.events",
				values: [event("e1")],
			})
		);
		expect(kafka.connect).not.toHaveBeenCalled();
	});

	test("gives a retried event the same deduplication token by event id or delivery id", async () => {
		const insert = vi.fn(() => Promise.resolve());
		const producer = createProducer({ insert });
		const span = { client_id: "ws_1", delivery_id: "d1", timestamp: 1 };

		await run(producer.sendOne("analytics-events", event("e1")));
		await run(
			producer.sendOne("analytics-events", { ...event("e1"), timestamp: 2 })
		);
		await run(producer.sendMany("analytics-events", [span], ["d1"]));
		await run(
			producer.sendMany("analytics-events", [{ ...span, timestamp: 2 }], ["d1"])
		);

		expect(insertedToken(insert, 0)).toBeTruthy();
		expect(insertedToken(insert, 1)).toBe(insertedToken(insert, 0));
		expect(insertedToken(insert, 3)).toBe(insertedToken(insert, 2));
		expect(insert).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({ values: [span] })
		);
	});

	test("strips delivery ids from custom-event rows without mutating the event", async () => {
		const insert = vi.fn(() => Promise.resolve());
		const producer = createProducer({ insert });
		const customEvent = {
			delivery_id: "d1",
			event_name: "checkout_completed",
			owner_id: "org_1",
			timestamp: 1,
		};

		await run(
			producer.sendMany("analytics-custom-events", [customEvent], ["d1"])
		);
		await run(
			producer.sendMany(
				"analytics-custom-events",
				[{ ...customEvent, timestamp: 2 }],
				["d1"]
			)
		);

		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				table: "analytics.custom_events",
				values: [
					{ event_name: "checkout_completed", owner_id: "org_1", timestamp: 1 },
				],
			})
		);
		expect(customEvent).toHaveProperty("delivery_id", "d1");
		expect(insertedToken(insert, 1)).toBe(insertedToken(insert, 0));
	});

	test("rejects with a retryable error when the insert fails or exceeds its deadline", async () => {
		const failing = createProducer({
			insert: vi.fn(() => Promise.reject(new Error("offline"))),
		});
		await expect(
			run(failing.sendOne("analytics-events", event("e1")))
		).rejects.toMatchObject({
			_tag: "ClickHouseFallbackError",
			retryable: true,
			table: "analytics.events",
			topic: "analytics-events",
		});
		expect(mockCaptureError).toHaveBeenCalledOnce();

		const stalledInsert = vi.fn(
			(_params: { abort_signal?: AbortSignal }) =>
				new Promise<void>(() => undefined)
		);
		const stalled = createProducer({
			config: { directFallbackTimeout: 20 },
			insert: stalledInsert,
		});
		await expect(
			run(stalled.sendOne("analytics-events", event("e2")))
		).rejects.toMatchObject({
			_tag: "ClickHouseFallbackError",
			retryable: true,
		});
		expect(stalledInsert.mock.calls[0]?.[0].abort_signal?.aborted).toBe(true);
	});

	test("rejects an unmapped topic as non-retryable", async () => {
		const producer = createProducer();

		await expect(
			run(producer.sendOne("analytics-unmapped", event("e1")))
		).rejects.toMatchObject({
			_tag: "UnknownKafkaTopicError",
			retryable: false,
			topic: "analytics-unmapped",
		});
		expect(mockCaptureError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Unknown Kafka topic" }),
			{ topic: "analytics-unmapped" }
		);
	});
});

describe("Kafka delivery", () => {
	test("keys custom events by delivery id and other events by their payload", async () => {
		const insert = vi.fn(() => Promise.resolve());
		const kafka = fakeKafka();
		const producer = createProducer({ config: withKafka, insert, kafka });
		const customEvent = { event_name: "checkout_completed", owner_id: "org_1" };

		await run(
			producer.sendMany("analytics-custom-events", [customEvent], ["d1"])
		);
		await run(producer.sendMany("analytics-events", [event("e1")], ["d2"]));

		expect(kafka.send).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				messages: [{ key: "d1", value: JSON.stringify(customEvent) }],
				topic: "analytics-custom-events",
			})
		);
		expect(kafka.send).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				messages: [{ key: "ws_1", value: JSON.stringify(event("e1")) }],
				topic: "analytics-events",
			})
		);
		expect(insert).not.toHaveBeenCalled();
	});

	test("shares one connection attempt across concurrent sends", async () => {
		const connection = deferred();
		const insert = vi.fn(() => Promise.resolve());
		const kafka = fakeKafka({ connect: vi.fn(() => connection.promise) });
		const producer = createProducer({ config: withKafka, insert, kafka });

		const deliveries = Array.from({ length: 50 }, (_, i) =>
			run(producer.sendOne("analytics-events", event(`e${i}`)))
		);
		await vi.waitFor(() => expect(kafka.connect).toHaveBeenCalledOnce());
		connection.resolve();
		await Promise.all(deliveries);

		expect(kafka.connect).toHaveBeenCalledOnce();
		expect(sentMessageCount(kafka.send)).toBe(50);
		expect(insert).not.toHaveBeenCalled();
	});

	test("falls back to ClickHouse during the reconnect cooldown after a failed connection", async () => {
		const connection = deferred();
		const insert = vi.fn(() => Promise.resolve());
		const kafka = fakeKafka({ connect: vi.fn(() => connection.promise) });
		const producer = createProducer({ config: withKafka, insert, kafka });

		const deliveries = Array.from({ length: 50 }, (_, i) =>
			run(producer.sendOne("analytics-events", event(`e${i}`)))
		);
		await vi.waitFor(() => expect(kafka.connect).toHaveBeenCalledOnce());
		connection.reject(new Error("broker unavailable"));
		await Promise.all(deliveries);
		await run(producer.sendOne("analytics-events", event("during_cooldown")));

		expect(kafka.connect).toHaveBeenCalledOnce();
		expect(insert).toHaveBeenCalledTimes(51);
		expect(mockLogWarn).toHaveBeenCalledOnce();
	});

	test("pins retries of an ambiguous send to Kafka while unrelated events fall back", async () => {
		const insert = vi.fn(() => Promise.resolve());
		const kafka = fakeKafka({
			send: vi.fn(() => Promise.reject(new Error("request timed out"))),
		});
		const producer = createProducer({ config: withKafka, insert, kafka });

		await expect(
			run(producer.sendOne("analytics-events", event("e1")))
		).rejects.toMatchObject({
			_tag: "KafkaSendError",
			topic: "analytics-events",
		});
		await expect(
			run(
				producer.sendOne("analytics-events", event("e1"), undefined, {
					allowDirectFallback: false,
				})
			)
		).rejects.toMatchObject({
			_tag: "ProducerUnavailableError",
			retryable: true,
		});
		expect(insert).not.toHaveBeenCalled();

		await run(producer.sendOne("analytics-events", event("unrelated")));
		expect(insert).toHaveBeenCalledOnce();
		expect(kafka.send).toHaveBeenCalledOnce();
		expect(mockCaptureError).toHaveBeenCalledOnce();
	});

	test("sends a rejected topic directly for the cooldown while other topics stay on Kafka", async () => {
		const insert = vi.fn(() => Promise.resolve());
		const topicRejection = new Error("Not authorized to access topics", {
			cause: Object.assign(new Error("Topic authorization failed"), {
				retriable: false,
				type: "TOPIC_AUTHORIZATION_FAILED",
			}),
		});
		const kafka = fakeKafka({
			send: vi.fn().mockRejectedValueOnce(topicRejection).mockResolvedValue([]),
		});
		const producer = createProducer({ config: withKafka, insert, kafka });

		await expect(
			run(producer.sendOne("analytics-events", event("rejected")))
		).rejects.toMatchObject({ _tag: "KafkaSendError" });
		await expect(
			run(
				producer.sendOne("analytics-events", event("rejected"), undefined, {
					allowDirectFallback: false,
				})
			)
		).rejects.toMatchObject({ _tag: "ProducerUnavailableError" });
		expect(insert).not.toHaveBeenCalled();

		await run(producer.sendOne("analytics-events", event("next")));
		await run(
			producer.sendMany(
				"analytics-custom-events",
				[{ event_name: "x" }],
				["d1"]
			)
		);

		expect(insert).toHaveBeenCalledOnce();
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({ table: "analytics.events" })
		);
		expect(kafka.connect).toHaveBeenCalledOnce();
		expect(kafka.send).toHaveBeenCalledTimes(2);
		expect(kafka.send).toHaveBeenLastCalledWith(
			expect.objectContaining({ topic: "analytics-custom-events" })
		);
	});

	test("disconnects a connection that completes after its deadline", async () => {
		const connection = deferred();
		const kafka = fakeKafka({ connect: vi.fn(() => connection.promise) });
		const kafkaAdmin = fakeAdmin();
		const producer = createProducer({
			config: { ...withKafka, connectTimeout: 20 },
			kafka,
			kafkaAdmin,
		});

		await expect(run(producer.checkConnection)).rejects.toMatchObject({
			_tag: "ProducerUnavailableError",
		});

		connection.resolve();
		await vi.waitFor(() => expect(kafka.disconnect).toHaveBeenCalledOnce());
		expect(kafkaAdmin.connect).not.toHaveBeenCalled();
	});
});

describe("Kafka batching", () => {
	const holdFirstSend = () => {
		const first = deferred<never[]>();
		const send = vi
			.fn()
			.mockImplementationOnce(() => first.promise)
			.mockResolvedValue([]);
		return { first, kafka: fakeKafka({ send }) };
	};

	test("sends events that queue behind an in-flight request as one ordered batch", async () => {
		const { first, kafka } = holdFirstSend();
		const producer = createProducer({ config: withKafka, kafka });

		const leading = run(producer.sendOne("analytics-events", event("e0")));
		await vi.waitFor(() => expect(kafka.send).toHaveBeenCalledOnce());
		const queued = Array.from({ length: 10 }, (_, i) =>
			run(producer.sendOne("analytics-events", event(`e${i + 1}`)))
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(kafka.send).toHaveBeenCalledOnce();

		first.resolve([]);
		await Promise.all([leading, ...queued]);

		expect(sentBatches(kafka.send)).toEqual([
			["e0"],
			Array.from({ length: 10 }, (_, i) => `e${i + 1}`),
		]);
	});

	test("caps each request at the batch message limit", async () => {
		const { first, kafka } = holdFirstSend();
		const producer = createProducer({
			config: { ...withKafka, maxBatchMessages: 3 },
			kafka,
		});

		const leading = run(producer.sendOne("analytics-events", event("e0")));
		await vi.waitFor(() => expect(kafka.send).toHaveBeenCalledOnce());
		const queued = Array.from({ length: 7 }, (_, i) =>
			run(producer.sendOne("analytics-events", event(`e${i + 1}`)))
		);
		first.resolve([]);
		await Promise.all([leading, ...queued]);

		expect(sentBatches(kafka.send).map((batch) => batch.length)).toEqual([
			1, 3, 3, 1,
		]);
	});

	test("rejects a failed batch as ambiguous and sends events still queued to ClickHouse", async () => {
		const { first, kafka } = holdFirstSend();
		const insert = vi.fn(() => Promise.resolve());
		const producer = createProducer({ config: withKafka, insert, kafka });

		const inFlight = run(producer.sendOne("analytics-events", event("sent")));
		await vi.waitFor(() => expect(kafka.send).toHaveBeenCalledOnce());
		const queuedFallback = run(
			producer.sendOne("analytics-events", event("queued"))
		);
		const queuedPinned = run(
			producer.sendOne("analytics-events", event("pinned"), undefined, {
				allowDirectFallback: false,
			})
		);
		first.reject(new Error("request timed out"));

		await expect(inFlight).rejects.toMatchObject({ _tag: "KafkaSendError" });
		await queuedFallback;
		await expect(queuedPinned).rejects.toMatchObject({
			_tag: "ProducerUnavailableError",
			retryable: true,
		});
		expect(kafka.send).toHaveBeenCalledOnce();
		expect(insert).toHaveBeenCalledOnce();
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({ values: [event("queued")] })
		);
	});

	test("drops blocked traffic when its queue is full but falls back for real events", async () => {
		const gate = deferred<never[]>();
		const kafka = fakeKafka({ send: vi.fn(() => gate.promise) });
		const insert = vi.fn(() => Promise.resolve());
		const producer = createProducer({
			config: { ...withKafka, kafkaTimeout: 5000, maxQueuedMessages: 2 },
			insert,
			kafka,
		});

		const send = (topic: string, id: string) =>
			run(producer.sendOne(topic, event(id)));
		const blocked = [send("analytics-blocked-traffic", "b0")];
		const real = [send("analytics-events", "r0")];
		await vi.waitFor(() => expect(kafka.send).toHaveBeenCalledTimes(2));
		for (const i of [1, 2, 3]) {
			blocked.push(send("analytics-blocked-traffic", `b${i}`));
			real.push(send("analytics-events", `r${i}`));
		}
		await blocked[3];
		await real[3];

		expect(mockLogWarn).toHaveBeenCalledWith(
			expect.objectContaining({ topic: "analytics-blocked-traffic" })
		);
		expect(insert).toHaveBeenCalledOnce();
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				table: "analytics.events",
				values: [event("r3")],
			})
		);

		gate.resolve([]);
		await Promise.all([...blocked, ...real]);
		const batches = sentBatches(kafka.send);
		expect(batches).toHaveLength(4);
		expect(batches).toEqual(
			expect.arrayContaining([["b0"], ["r0"], ["b1", "b2"], ["r1", "r2"]])
		);
	});

	test("starts the next request only after the previous send settles, even past its deadline", async () => {
		const { first, kafka } = holdFirstSend();
		const insert = vi.fn(() => Promise.resolve());
		const producer = createProducer({
			config: { ...withKafka, kafkaTimeout: 20, reconnectCooldown: 1 },
			insert,
			kafka,
		});

		await expect(
			run(producer.sendOne("analytics-events", event("slow")))
		).rejects.toMatchObject({ _tag: "KafkaSendError" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		const next = run(producer.sendOne("analytics-events", event("next")));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(kafka.send).toHaveBeenCalledOnce();

		first.resolve([]);
		await next;
		expect(sentMessageCount(kafka.send) + insert.mock.calls.length).toBe(2);
	});
});

describe("health check", () => {
	test("probes live broker metadata on every check", async () => {
		const kafka = fakeKafka();
		const kafkaAdmin = fakeAdmin({
			describeCluster: vi
				.fn()
				.mockResolvedValueOnce(cluster)
				.mockRejectedValueOnce(new Error("metadata unavailable")),
		});
		const producer = createProducer({ config: withKafka, kafka, kafkaAdmin });

		await run(producer.checkConnection);
		await expect(run(producer.checkConnection)).rejects.toMatchObject({
			_tag: "ProducerUnavailableError",
			cause: expect.objectContaining({ message: "metadata unavailable" }),
		});

		expect(kafka.connect).toHaveBeenCalledOnce();
		expect(kafkaAdmin.describeCluster).toHaveBeenCalledTimes(2);
		expect(kafkaAdmin.disconnect).toHaveBeenCalledOnce();
	});

	test("names the topics missing from Redpanda", async () => {
		const producer = createProducer({
			config: withKafka,
			kafka: fakeKafka(),
			kafkaAdmin: fakeAdmin({
				listTopics: vi.fn(() =>
					Promise.resolve(["analytics-blocked-traffic", "analytics-events"])
				),
			}),
		});

		await expect(run(producer.checkConnection)).rejects.toMatchObject({
			cause: expect.objectContaining({
				message: "Redpanda is missing topics: analytics-custom-events",
			}),
		});
	});

	test("fails without probing metadata when the producer cannot connect", async () => {
		const kafkaAdmin = fakeAdmin();
		const producer = createProducer({
			config: withKafka,
			kafka: fakeKafka({
				connect: vi.fn(() => Promise.reject(new Error("broker unavailable"))),
			}),
			kafkaAdmin,
		});

		await expect(run(producer.checkConnection)).rejects.toMatchObject({
			_tag: "ProducerUnavailableError",
			cause: expect.objectContaining({
				message: "Redpanda producer is not connected",
			}),
		});
		expect(kafkaAdmin.connect).not.toHaveBeenCalled();
	});

	test("bounds a stalled metadata probe", async () => {
		const metadata = deferred<typeof cluster>();
		const kafkaAdmin = fakeAdmin({
			describeCluster: vi.fn(() => metadata.promise),
			disconnect: vi.fn(() => {
				metadata.reject(new Error("metadata connection closed"));
				return Promise.resolve();
			}),
		});
		const producer = createProducer({
			config: { ...withKafka, healthProbeTimeout: 20 },
			kafka: fakeKafka(),
			kafkaAdmin,
		});

		const startedAt = performance.now();
		await expect(run(producer.checkConnection)).rejects.toMatchObject({
			cause: expect.objectContaining({
				message: "Redpanda health probe exceeded 20ms",
			}),
		});
		expect(performance.now() - startedAt).toBeLessThan(500);
		await vi.waitFor(() =>
			expect(kafkaAdmin.disconnect).toHaveBeenCalledOnce()
		);
	});
});

describe("shutdown", () => {
	test("rejects new work while waiting for in-flight deliveries", async () => {
		const insertDone = deferred();
		const insert = vi.fn(() => insertDone.promise);
		const producer = createProducer({
			config: { shutdownDrainTimeout: 500 },
			insert,
		});

		const inFlight = run(producer.sendOne("analytics-events", event("e1")));
		await vi.waitFor(() => expect(insert).toHaveBeenCalledOnce());
		const shutdown = run(producer.shutDown);

		await expect(
			run(producer.sendOne("analytics-events", event("e2")))
		).rejects.toMatchObject({
			_tag: "ProducerShuttingDownError",
			retryable: true,
		});
		await expect(run(producer.checkConnection)).rejects.toMatchObject({
			_tag: "ProducerUnavailableError",
		});
		expect(await settlesWithin(shutdown, 30)).toBe(false);

		insertDone.resolve();
		await inFlight;
		await shutdown;
	});

	test("reports undelivered events when the drain deadline passes", async () => {
		const insertDone = deferred();
		const insert = vi.fn(() => insertDone.promise);
		const producer = createProducer({
			config: { shutdownDrainTimeout: 20 },
			insert,
		});

		const inFlight = run(producer.sendOne("analytics-events", event("e1")));
		await vi.waitFor(() => expect(insert).toHaveBeenCalledOnce());
		await expect(run(producer.shutDown)).rejects.toMatchObject({
			_tag: "ShutdownDrainError",
			inFlight: 1,
			retryable: true,
		});

		insertDone.resolve();
		await inFlight;
	});

	test("waits for a send acknowledged after its deadline", async () => {
		const acknowledgement = deferred<[]>();
		const producer = createProducer({
			config: { ...withKafka, kafkaTimeout: 20, shutdownDrainTimeout: 500 },
			kafka: fakeKafka({ send: vi.fn(() => acknowledgement.promise) }),
		});

		await expect(
			run(producer.sendOne("analytics-events", event("e1")))
		).rejects.toMatchObject({
			_tag: "KafkaSendError",
			cause: expect.objectContaining({
				message: "Redpanda send acknowledgement exceeded 20ms",
			}),
		});
		const shutdown = run(producer.shutDown);
		expect(await settlesWithin(shutdown, 30)).toBe(false);

		acknowledgement.resolve([]);
		await shutdown;
	});

	test("bounds a stalled admin disconnect", async () => {
		const kafka = fakeKafka();
		const kafkaAdmin = fakeAdmin({
			disconnect: vi.fn(() => new Promise<void>(() => undefined)),
		});
		const producer = createProducer({
			config: { ...withKafka, shutdownDrainTimeout: 20 },
			kafka,
			kafkaAdmin,
		});
		await run(producer.checkConnection);

		await expect(run(producer.shutDown)).rejects.toMatchObject({
			_tag: "ShutdownDrainError",
			deadlineMs: 20,
			phase: "disconnect",
		});
		expect(kafka.disconnect).toHaveBeenCalledOnce();
		expect(kafkaAdmin.disconnect).toHaveBeenCalledOnce();
	});

	test("does not publish a connection that completes after shutdown starts", async () => {
		const connection = deferred();
		const kafka = fakeKafka({ connect: vi.fn(() => connection.promise) });
		const kafkaAdmin = fakeAdmin();
		const producer = createProducer({
			config: { ...withKafka, shutdownDrainTimeout: 500 },
			kafka,
			kafkaAdmin,
		});

		const firstCheck = expect(
			run(producer.checkConnection)
		).rejects.toMatchObject({ _tag: "ProducerUnavailableError" });
		await vi.waitFor(() => expect(kafka.connect).toHaveBeenCalledOnce());
		const shutdown = run(producer.shutDown);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(run(producer.checkConnection)).rejects.toMatchObject({
			_tag: "ProducerUnavailableError",
		});
		connection.resolve();
		await firstCheck;
		await shutdown;

		expect(kafka.connect).toHaveBeenCalledOnce();
		expect(kafka.disconnect).toHaveBeenCalledOnce();
		expect(kafkaAdmin.connect).not.toHaveBeenCalled();
	});

	test("waits for an active health probe before disconnecting", async () => {
		const metadata = deferred<typeof cluster>();
		const kafka = fakeKafka();
		const kafkaAdmin = fakeAdmin({
			describeCluster: vi.fn(() => metadata.promise),
		});
		const producer = createProducer({
			config: {
				...withKafka,
				healthProbeTimeout: 500,
				shutdownDrainTimeout: 500,
			},
			kafka,
			kafkaAdmin,
		});

		const check = expect(run(producer.checkConnection)).rejects.toMatchObject({
			_tag: "ProducerUnavailableError",
		});
		await vi.waitFor(() =>
			expect(kafkaAdmin.describeCluster).toHaveBeenCalledOnce()
		);
		const shutdown = run(producer.shutDown);
		expect(await settlesWithin(shutdown, 30)).toBe(false);

		metadata.resolve(cluster);
		await check;
		await shutdown;

		expect(kafkaAdmin.disconnect).toHaveBeenCalledOnce();
		expect(kafka.disconnect).toHaveBeenCalledOnce();
	});
});

const vectorConfig = await readFile(
	new URL("../../../../infra/ingest/vector.yaml", import.meta.url),
	"utf8"
);
const uptimeProducer = await readFile(
	new URL("../../../uptime/src/lib/producer.ts", import.meta.url),
	"utf8"
);
const producedTopics: Record<string, string> = {
	...TOPIC_MAP,
	[`${uptimeProducer.match(/const TOPIC = "([\w-]+)"/)?.[1]}`]: `${
		uptimeProducer.match(/table: "(\w+\.\w+)"/)?.[1]
	}`,
};

test("Vector consumes every produced topic into its ClickHouse table", () => {
	const consumedTopics = vectorConfig
		.match(/^ {6}- analytics-[\w-]+$/gm)
		?.map((line) => line.trim().slice(2));
	expect(consumedTopics?.sort()).toEqual(Object.keys(producedTopics).sort());
	for (const [topic, table] of Object.entries(producedTopics)) {
		const route = vectorConfig.match(
			new RegExp(`(\\w+): '\\.topic == "${topic}"'`)
		)?.[1];
		const sink = vectorConfig.match(
			new RegExp(
				`- route_analytics\\.${route}\\n[\\s\\S]*?INSERT\\+INTO\\+(\\w+)\\.(\\w+)\\+FORMAT`
			)
		);
		expect(`${sink?.[1]}.${sink?.[2]}`, topic).toBe(table);
	}
});

test("every Vector ClickHouse sink shares one delivery config", () => {
	const sinks = vectorConfig
		.slice(vectorConfig.indexOf("\nsinks:\n"))
		.split(/\n {2}(?=\w+:\n)/)
		.filter((block) => block.includes("\n    type: http\n"))
		.map((block) =>
			block
				.replace(/^\w+:/, "")
				.replace(/route_analytics\.\w+/, "")
				.replace(/INSERT\+INTO\+\w+\.\w+/, "")
				.replace(/\n {4}batch:\n(?: {6}.*\n)+/, "\n")
		);
	expect(sinks).toHaveLength(Object.keys(producedTopics).length);
	expect(new Set(sinks).size).toBe(1);
});
