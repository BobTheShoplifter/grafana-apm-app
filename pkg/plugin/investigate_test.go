package plugin

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anthropics/anthropic-sdk-go"

	"github.com/nais/grafana-otel-plugin/pkg/plugin/otelconfig"
	"github.com/nais/grafana-otel-plugin/pkg/plugin/queries"
)

// scriptedModel returns canned messages, one per step, and records each request.
type scriptedModel struct {
	mu       sync.Mutex
	replies  []string
	requests []anthropic.BetaMessageNewParams
}

func (m *scriptedModel) step(_ context.Context, params anthropic.BetaMessageNewParams, onText, _ func(string)) (*anthropic.BetaMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests = append(m.requests, params)
	reply := m.replies[0]
	m.replies = m.replies[1:]
	var msg anthropic.BetaMessage
	if err := json.Unmarshal([]byte(reply), &msg); err != nil {
		return nil, err
	}
	for _, b := range msg.Content {
		if t, ok := b.AsAny().(anthropic.BetaTextBlock); ok {
			onText(t.Text)
		}
	}
	return &msg, nil
}

func toolUseReply(id, name, input string) string {
	return `{"id":"m","type":"message","role":"assistant","model":"m","stop_reason":"tool_use",
		"usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":50},
		"content":[{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":` + input + `}]}`
}

func textReply(text string) string {
	return `{"id":"m","type":"message","role":"assistant","model":"m","stop_reason":"end_turn",
		"usage":{"input_tokens":200,"output_tokens":20},
		"content":[{"type":"text","text":"` + text + `"}]}`
}

// newInvestigationTestApp serves a fake datasource proxy: Prometheus range queries answer one
// series, Loki answers one stream.
func newInvestigationTestApp(t *testing.T) (*App, *[]string) {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	grafana := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.URL.Path+"?"+r.URL.RawQuery)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/uid/mimir/api/v1/query_range"):
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[
				{"metric":{"service":"checkout"},"values":[[1700000000,"1"],[1700000060,"5"],[1700000120,"3"]]}]}}`))
		case strings.HasSuffix(r.URL.Path, "/uid/loki/loki/api/v1/query_range"):
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"streams","result":[
				{"stream":{"service_name":"checkout"},"values":[["1700000000000000000","boom: connection refused"]]}]}}`))
		default:
			http.Error(w, "bad query: parse error", http.StatusBadRequest)
		}
	}))
	t.Cleanup(grafana.Close)
	app := &App{
		otelCfg:      otelconfig.Default(),
		respCache:    newResponseCache(),
		healthClient: &http.Client{Timeout: 5 * time.Second},
		grafanaURL:   grafana.URL,
		anthropicKey: "test-key",
		settings: queries.PluginSettings{
			MetricsDataSource: queries.EnvAwareDataSource{UID: "mimir"},
			TracesDataSource:  queries.EnvAwareDataSource{UID: "tempo"},
			LogsDataSource:    queries.EnvAwareDataSource{UID: "loki"},
			Investigation:     queries.InvestigationSettings{Context: "Pod logs carry a namespace label."},
		},
	}
	app.capCache = &cachedCapabilities{caps: defaultCaps(), fetchedAt: time.Now()}
	return app, &seen
}

type sentEvent struct {
	typ  string
	data map[string]any
}

func newTestInvestigation(app *App, model investigationModel, events *[]sentEvent) *investigation {
	var mu sync.Mutex
	end := time.Now()
	return &investigation{
		app: app, model: model, settings: app.investigationSettings(),
		headers: http.Header{}, http: &http.Client{Timeout: 5 * time.Second},
		namespace: "shop", service: "checkout", start: end.Add(-time.Hour), end: end,
		emit: func(typ string, payload any) {
			raw, _ := json.Marshal(payload)
			var m map[string]any
			_ = json.Unmarshal(raw, &m)
			mu.Lock()
			*events = append(*events, sentEvent{typ, m})
			mu.Unlock()
		},
	}
}

func TestInvestigationRunsToolsAndAnswers(t *testing.T) {
	app, seen := newInvestigationTestApp(t)
	model := &scriptedModel{replies: []string{
		toolUseReply("t1", "query_metrics", `{"query":"sum(rate(calls[5m]))"}`),
		textReply("## Summary\\nAll good."),
	}}
	var events []sentEvent
	inv := newTestInvestigation(app, model, &events)

	usage, rounds, err := inv.run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if rounds != 2 {
		t.Fatalf("rounds = %d, want 2", rounds)
	}
	if usage.Input != 300 || usage.Output != 30 || usage.CacheRead != 50 {
		t.Fatalf("usage = %+v", usage)
	}
	if len(*seen) != 1 || !strings.Contains((*seen)[0], "query=sum%28rate%28calls") {
		t.Fatalf("datasource calls = %v", *seen)
	}

	// The second request carries the tool result, summarised.
	second := model.requests[1]
	last := second.Messages[len(second.Messages)-1]
	raw, _ := json.Marshal(last)
	if !strings.Contains(string(raw), `first 1, last 3, min 1, max 5`) {
		t.Fatalf("tool result not passed back: %s", raw)
	}

	types := []string{}
	for _, e := range events {
		types = append(types, e.typ)
	}
	want := "start,tool_call,tool_result,text,done"
	if strings.Join(types, ",") != want {
		t.Fatalf("events = %v, want %s", types, want)
	}
}

func TestInvestigationRequestShape(t *testing.T) {
	app, _ := newInvestigationTestApp(t)
	model := &scriptedModel{replies: []string{textReply("ok")}}
	var events []sentEvent
	inv := newTestInvestigation(app, model, &events)
	if _, _, err := inv.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	req := model.requests[0]
	if req.Model != defaultInvestigationModel {
		t.Errorf("model = %q", req.Model)
	}
	if req.OutputConfig.Effort != anthropic.BetaOutputConfigEffortHigh {
		t.Errorf("effort = %q", req.OutputConfig.Effort)
	}
	if len(req.Tools) != 5 {
		t.Errorf("tools = %d, want 5", len(req.Tools))
	}
	if req.Fallbacks.OfDefault != "default" || req.Thinking.OfAdaptive.Display != "updates" || len(req.Betas) != 2 {
		t.Errorf("default model should use fallbacks and progress updates: fallbacks=%q display=%q betas=%v",
			req.Fallbacks.OfDefault, req.Thinking.OfAdaptive.Display, req.Betas)
	}
	sys := req.System[0].Text
	for _, want := range []string{`"checkout"`, `namespace "shop"`, "Pod logs carry a namespace label.", "not instructions"} {
		if !strings.Contains(sys, want) {
			t.Errorf("system prompt lacks %q", want)
		}
	}
}

func TestInvestigationRoundLimitForcesAnAnswer(t *testing.T) {
	app, _ := newInvestigationTestApp(t)
	app.settings.Investigation.MaxRounds = 1
	model := &scriptedModel{replies: []string{
		toolUseReply("t1", "query_logs", `{"query":"{service_name=\"checkout\"} |= \"error\""}`),
		textReply("report"),
	}}
	var events []sentEvent
	inv := newTestInvestigation(app, model, &events)
	_, rounds, err := inv.run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rounds != 2 {
		t.Fatalf("rounds = %d", rounds)
	}
	final := model.requests[1]
	if final.ToolChoice.OfNone == nil {
		t.Fatal("the last request should forbid tools")
	}
	raw, _ := json.Marshal(final.Messages[len(final.Messages)-1])
	if !strings.Contains(string(raw), "Write the final report now") || !strings.Contains(string(raw), "boom: connection refused") {
		t.Fatalf("last user turn: %s", raw)
	}
}

func TestInvestigationToolErrorsGoBackToTheModel(t *testing.T) {
	app, _ := newInvestigationTestApp(t)
	model := &scriptedModel{replies: []string{
		toolUseReply("t1", "query_metrics", `{"query":"up","instant":true}`), // the fake answers 400 to instant queries
		textReply("done"),
	}}
	var events []sentEvent
	inv := newTestInvestigation(app, model, &events)
	if _, _, err := inv.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(model.requests[1].Messages[2])
	if !strings.Contains(string(raw), `"is_error":true`) || !strings.Contains(string(raw), "bad query: parse error") {
		t.Fatalf("error result: %s", raw)
	}
	for _, e := range events {
		if e.typ == "tool_result" && e.data["ok"] != false {
			t.Fatalf("tool_result ok = %v", e.data["ok"])
		}
	}
}

func TestInvestigationRefusalStops(t *testing.T) {
	app, _ := newInvestigationTestApp(t)
	model := &scriptedModel{replies: []string{`{"id":"m","type":"message","role":"assistant","model":"m",
		"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":""},
		"usage":{"input_tokens":1,"output_tokens":1},"content":[]}`}}
	var events []sentEvent
	_, _, err := newTestInvestigation(app, model, &events).run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "declined") {
		t.Fatalf("err = %v", err)
	}
}

func TestInvestigationSettingsDefaultsAndLimits(t *testing.T) {
	a := &App{}
	r := a.investigationSettings()
	if r.model != defaultInvestigationModel || r.effort != "high" || r.maxRounds != defaultInvestigationRounds {
		t.Fatalf("defaults = %+v", r)
	}
	a.settings.Investigation = queries.InvestigationSettings{Model: " claude-sonnet-5-5 ", Effort: "MEDIUM", MaxRounds: 99}
	r = a.investigationSettings()
	if r.model != "claude-sonnet-5-5" || r.effort != "medium" || r.maxRounds != maxInvestigationRounds {
		t.Fatalf("resolved = %+v", r)
	}
	a.settings.Investigation.Effort = "extreme"
	if got := a.investigationSettings().effort; got != "high" {
		t.Fatalf("unknown effort resolved to %q", got)
	}
}

func TestInvestigationWindow(t *testing.T) {
	now := time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC)
	s, e, err := investigationWindow(0, 0, now)
	if err != nil || e != now || now.Sub(s) != time.Hour {
		t.Fatalf("default window = %v %v %v", s, e, err)
	}
	if _, _, err := investigationWindow(now.UnixMilli(), now.Add(-time.Minute).UnixMilli(), now); err == nil {
		t.Fatal("an inverted window should fail")
	}
	if _, _, err := investigationWindow(now.Add(-8*24*time.Hour).UnixMilli(), now.UnixMilli(), now); err == nil {
		t.Fatal("a window over 7 days should fail")
	}
	_, e, err = investigationWindow(now.Add(-time.Hour).UnixMilli(), now.Add(time.Hour).UnixMilli(), now)
	if err != nil || e != now {
		t.Fatalf("a future end should clamp to now: %v %v", e, err)
	}
}

func TestSanitizeEnvironment(t *testing.T) {
	for in, want := range map[string]string{"prod": "prod", " staging-us ": "staging-us", `x"}`: "", "a b": ""} {
		if got := sanitizeEnvironment(in); got != want {
			t.Errorf("sanitizeEnvironment(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHandleInvestigateGuards(t *testing.T) {
	app, _ := newInvestigationTestApp(t)
	call := func(method, role string, key string) *httptest.ResponseRecorder {
		app.anthropicKey = key
		req := httptest.NewRequest(method, "/services/shop/checkout/investigate", strings.NewReader(`{}`))
		req.SetPathValue("namespace", "shop")
		req.SetPathValue("service", "checkout")
		if role != "" {
			req.Header.Set("X-Grafana-Org-Role", role)
		}
		rec := httptest.NewRecorder()
		app.handleInvestigate(rec, req)
		return rec
	}
	if rec := call(http.MethodGet, "Editor", "k"); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d", rec.Code)
	}
	if rec := call(http.MethodPost, "Viewer", "k"); rec.Code != http.StatusForbidden {
		t.Errorf("viewer = %d", rec.Code)
	}
	if rec := call(http.MethodPost, "Editor", ""); rec.Code != http.StatusPreconditionFailed {
		t.Errorf("no key = %d", rec.Code)
	}
}

func TestHandleInvestigateStreamsEvents(t *testing.T) {
	app, _ := newInvestigationTestApp(t)
	orig := newInvestigationModel
	t.Cleanup(func() { newInvestigationModel = orig })
	newInvestigationModel = func(string) investigationModel {
		return &scriptedModel{replies: []string{textReply("all clear")}}
	}
	req := httptest.NewRequest(http.MethodPost, "/services/shop/checkout/investigate",
		strings.NewReader(`{"question":"why slow?","environment":"prod"}`))
	req.SetPathValue("namespace", "shop")
	req.SetPathValue("service", "checkout")
	req.Header.Set("X-Grafana-Org-Role", "Admin")
	rec := httptest.NewRecorder()
	app.handleInvestigate(rec, req)

	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type = %q", ct)
	}
	var types []string
	sc := bufio.NewScanner(rec.Body)
	for sc.Scan() {
		if line := sc.Text(); strings.HasPrefix(line, "event: ") {
			types = append(types, strings.TrimPrefix(line, "event: "))
		}
	}
	if strings.Join(types, ",") != "start,text,done" {
		t.Fatalf("events = %v", types)
	}
}

func TestStatusReportsAvailability(t *testing.T) {
	app, _ := newInvestigationTestApp(t)
	for key, want := range map[string]bool{"": false, "k": true} {
		app.anthropicKey = key
		rec := httptest.NewRecorder()
		app.handleInvestigateStatus(rec, httptest.NewRequest(http.MethodGet, "/investigate/status", nil))
		var st InvestigateStatus
		_ = json.Unmarshal(rec.Body.Bytes(), &st)
		if st.Available != want {
			t.Errorf("key %q: available = %v", key, st.Available)
		}
	}
}

func TestFormatPromStyleVectorAndLimits(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"status":"success","data":{"resultType":"vector","result":[`)
	for i := 0; i < maxToolSeries+5; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"metric":{"pod":"p` + string(rune('a'+i%26)) + `"},"value":[1700000000,"0.25"]}`)
	}
	b.WriteString(`]}}`)
	out, err := formatPromStyle([]byte(b.String()))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "35 series (showing 30") || !strings.Contains(out, "= 0.25 @") {
		t.Fatalf("out = %s", out)
	}
}

func TestSummariseTrace(t *testing.T) {
	body := `[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout"}}]},
		"scopeSpans":[{"spans":[
			{"spanId":"a","name":"POST /pay","startTimeUnixNano":"1000000000","endTimeUnixNano":"3000000000",
			 "attributes":[{"key":"http.route","value":{"stringValue":"/pay"}},{"key":"ignored","value":{"stringValue":"x"}}]},
			{"spanId":"b","parentSpanId":"a","name":"db query","startTimeUnixNano":"1100000000","endTimeUnixNano":"2900000000",
			 "status":{"code":"STATUS_CODE_ERROR","message":"timeout"},
			 "events":[{"name":"exception","attributes":[{"key":"exception.message","value":{"stringValue":"pool exhausted"}}]}]}
		]}]}]`
	var batches []otlpResourceSpans
	if err := json.Unmarshal([]byte(body), &batches); err != nil {
		t.Fatal(err)
	}
	out := summariseTrace("abc", batches)
	for _, want := range []string{"2 spans over 2000ms", "checkout (2)", `http.route="/pay"`, `status="timeout"`, "pool exhausted"} {
		if !strings.Contains(out, want) {
			t.Errorf("summary lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "ignored") {
		t.Errorf("summary shows an attribute it should drop:\n%s", out)
	}
}

func TestTruncateKeepsUTF8(t *testing.T) {
	s := strings.Repeat("é", 10) // 2 bytes each
	out := truncate(s, 5)
	if !strings.HasPrefix(out, "éé") || strings.Contains(out[:5], "\uFFFD") {
		t.Fatalf("truncate = %q", out)
	}
}

func TestInvestigationModelFeatureGates(t *testing.T) {
	app, _ := newInvestigationTestApp(t)
	app.settings.Investigation.Model = "claude-haiku-5-5"
	model := &scriptedModel{replies: []string{textReply("ok")}}
	var events []sentEvent
	if _, _, err := newTestInvestigation(app, model, &events).run(context.Background()); err != nil {
		t.Fatal(err)
	}
	req := model.requests[0]
	if req.Fallbacks.OfDefault != "" || len(req.Betas) != 0 || req.Thinking.OfAdaptive.Display != "summarized" {
		t.Fatalf("haiku should get no betas and summarised thinking: fallbacks=%q betas=%v display=%q",
			req.Fallbacks.OfDefault, req.Betas, req.Thinking.OfAdaptive.Display)
	}
}

func TestKeepAliveStopWaitsForTheWriter(t *testing.T) {
	rec := httptest.NewRecorder()
	stream, ok := newEventStream(rec)
	if !ok {
		t.Fatal("recorder should flush")
	}
	stop := stream.keepAlive(time.Millisecond)
	time.Sleep(10 * time.Millisecond)
	stop()
	n := rec.Body.Len()
	time.Sleep(10 * time.Millisecond)
	if rec.Body.Len() != n || !strings.Contains(rec.Body.String(), ": keep-alive") {
		t.Fatalf("keep-alive wrote after stop or never: %q", rec.Body.String())
	}
	stop() // a second stop is harmless
}
