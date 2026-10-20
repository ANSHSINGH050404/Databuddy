"use client";

import Script from "next/script";

export function DubAnalytics() {
	return (
		<Script
			data-cookie-options='{"domain":".databuddy.cc"}'
			data-publishable-key="dub_pk_TbFwfIKx6BtgspSSbNDcDVRE"
			src="https://www.dubcdn.com/analytics/script.outbound-domains.conversion-tracking.js"
			strategy="afterInteractive"
		/>
	);
}
