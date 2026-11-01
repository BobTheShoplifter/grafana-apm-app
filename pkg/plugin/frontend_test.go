package plugin

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// lcpInWindow answers only a windowed look at the LCP histogram: the series reported within the
// last 6h but is not live now (Alloy dropped it after max_idle_duration) and shows no increase.
func lcpInWindow(now time.Time) map[string][]queries.PromResult {
	return map[string][]queries.PromResult{
		"last_over_time(loki_process_custom_faro_web_vitals_lcp_milliseconds_bucket": {
			{Metric: map[string]string{}, Value: queries.NewPromValue(float64(now.Unix()), "4")},
		},
	}
}

func TestFrontendAvailableWhenTheSeriesReportedInTheWindowButIsIdleNow(t *testing.T) {
	now := time.Now()
	srv, captured := queryCapturingPromServer(t, lcpInWindow(now))
	defer srv.Close()
	app := newTestApp(t, srv.URL, defaultCaps())

	resp := app.queryFrontendFromAlloyHistogram(context.Background(), "cdn", "stagingk8s", now)
	if !resp.Available {
		t.Fatalf("want available for an app that reported within the window, queries: %v", *captured)
	}
	for _, q := range *captured {
		if strings.Contains(q, "last_over_time(") && !strings.Contains(q, `app_name="cdn"`) {
			t.Errorf("windowed probe lost the service filter: %s", q)
		}
	}
}

func TestScorecardBrowserTelemetryLooksOverTheWindow(t *testing.T) {
	now := time.Now()
	srv, captured := queryCapturingPromServer(t, lcpInWindow(now))
	defer srv.Close()
	app := newTestApp(t, srv.URL, defaultCaps())

	if !app.checkBrowserTelemetry(context.Background(), "cdn", "stagingk8s", now) {
		t.Fatalf("want browser telemetry for an app that reported within the window, queries: %v", *captured)
	}
}
