import { describe, expect, it } from "bun:test";
import {
	GATED_FEATURES,
	isRenewingSubscription,
	getNextPlanForFeature,
	getPlanCapabilities,
	getPlanFeatureLimit,
	INTELLIGENCE_PLAN_IDS,
	PLAN_IDS,
} from "./features";

describe("plan feature helpers", () => {
	it("gives intelligence plans Scale capabilities", () => {
		expect(getPlanCapabilities(INTELLIGENCE_PLAN_IDS.ANALYST)).toEqual(
			getPlanCapabilities(PLAN_IDS.SCALE)
		);
		expect(getPlanCapabilities(INTELLIGENCE_PLAN_IDS.DATA_TEAM)).toEqual(
			getPlanCapabilities(PLAN_IDS.SCALE)
		);
	});

	it("treats unknown plan ids as free instead of throwing", () => {
		expect(
			getPlanFeatureLimit("legacy-enterprise", GATED_FEATURES.FUNNELS)
		).toBe(1);
		expect(
			getNextPlanForFeature("legacy-enterprise", GATED_FEATURES.ERROR_TRACKING)
		).toBe(PLAN_IDS.HOBBY);
		expect(getPlanCapabilities("legacy-enterprise")).toBe(
			getPlanCapabilities(PLAN_IDS.FREE)
		);
	});
});

describe("isRenewingSubscription", () => {
	it("does not treat an explicitly attached Free plan as renewing", () => {
		expect(
			isRenewingSubscription({
				autoEnable: false,
				canceledAt: null,
				planId: "free",
			})
		).toBe(false);
	});

	it("treats an uncanceled paid plan as renewing until it is canceled", () => {
		expect(
			isRenewingSubscription({
				autoEnable: false,
				canceledAt: null,
				planId: "pro",
			})
		).toBe(true);
		expect(
			isRenewingSubscription({
				autoEnable: false,
				canceledAt: 1_792_000_000_000,
				planId: "pro",
			})
		).toBe(false);
	});

	it("does not treat auto-enabled plans as renewing", () => {
		expect(
			isRenewingSubscription({
				autoEnable: true,
				canceledAt: null,
				planId: "free",
			})
		).toBe(false);
	});
});
