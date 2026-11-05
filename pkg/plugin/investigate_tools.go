package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
)

// The investigation's tools. Every one is a read through Grafana's datasource proxy with the
// request's auth; none can change anything. Results are plain text, summarised and capped so a
// broad query cannot flood the model's context.

const (
	investigationToolTimeout = 45 * time.Second
	maxToolResultChars       = 12000
	maxToolSeries            = 30
	maxToolPoints            = 8
	maxLogLineChars          = 500
	maxLogLines              = 200
	defaultLogLines          = 50
	maxTraceResults          = 20
	defaultTraceResults      = 10
	maxLabelValues           = 200
)

type investigationTool struct {
	name        string
	description string
	properties  map[string]any
	required    []string
	run         func(ctx context.Context, inv *investigation, raw json.RawMessage) (string, error)
}

var timeProps = map[string]any{
	"start": map[string]any{"type": "string", "description": "RFC 3339 start time. Defaults to the investigation window's start."},
	"end":   map[string]any{"type": "string", "description": "RFC 3339 end time. Defaults to the investigation window's end."},
}

func withTimeProps(props map[string]any) map[string]any {
	for k, v := range timeProps {
		props[k] = v
	}
	return props
}

func investigationTools() map[string]investigationTool {
	tools := []investigationTool{
		{
			name: "query_metrics",
			description: "Run a PromQL query against the metrics store (Prometheus API). Range queries return, per series, " +
				"the first, last, min, max and mean value and a few sample points; instant queries return one value per " +
				"series. Use aggregations (sum by, rate, histogram_quantile, topk) to keep the result small.",
			properties: withTimeProps(map[string]any{
				"query":   map[string]any{"type": "string", "description": "The PromQL expression."},
				"instant": map[string]any{"type": "boolean", "description": "Evaluate once at the end time instead of over the range. Default false."},
				"step":    map[string]any{"type": "string", "description": "Range query resolution, e.g. 30s or 5m. Default: about 120 points over the range."},
			}),
			required: []string{"query"},
			run:      runQueryMetrics,
		},
		{
			name: "query_logs",
			description: "Run a LogQL query against the log store (Loki). A log query returns the newest matching lines " +
				"(or oldest with direction=forward), grouped by stream; a metric query (rate, count_over_time, ...) " +
				"returns summarised series like query_metrics. Always filter (|= \"error\", | json | level=\"error\", ...) " +
				"rather than reading everything.",
			properties: withTimeProps(map[string]any{
				"query":     map[string]any{"type": "string", "description": "The LogQL expression, starting with a stream selector."},
				"limit":     map[string]any{"type": "integer", "description": fmt.Sprintf("Maximum log lines, 1-%d. Default %d.", maxLogLines, defaultLogLines)},
				"direction": map[string]any{"type": "string", "enum": []string{"backward", "forward"}, "description": "backward (newest first, default) or forward."},
			}),
			required: []string{"query"},
			run:      runQueryLogs,
		},
		{
			name: "search_traces",
			description: "Search traces with TraceQL (Tempo). Returns trace ids with root service, root span, start time " +
				"and duration, plus the spans that matched. Example: {resource.service.name=\"checkout\" && status=error} " +
				"or {resource.service.name=\"checkout\" && duration > 2s}.",
			properties: withTimeProps(map[string]any{
				"query": map[string]any{"type": "string", "description": "The TraceQL query."},
				"limit": map[string]any{"type": "integer", "description": fmt.Sprintf("Maximum traces, 1-%d. Default %d.", maxTraceResults, defaultTraceResults)},
			}),
			required: []string{"query"},
			run:      runSearchTraces,
		},
		{
			name: "get_trace",
			description: "Fetch one trace by id and summarise it: services involved, the root span, every span with an " +
				"error status (with exception messages) and the slowest spans with their key attributes.",
			properties: map[string]any{
				"trace_id": map[string]any{"type": "string", "description": "The trace id (hex)."},
			},
			required: []string{"trace_id"},
			run:      runGetTrace,
		},
		{
			name: "list_labels",
			description: "Discover label names, or the values of one label, in the metrics or log store. Use it when a " +
				"query returns nothing to check which labels and values exist. `match` narrows to series or streams " +
				"matching a selector, e.g. {namespace=\"payments\"}.",
			properties: withTimeProps(map[string]any{
				"source": map[string]any{"type": "string", "enum": []string{"metrics", "logs"}, "description": "Which store to ask."},
				"label":  map[string]any{"type": "string", "description": "The label whose values to list. Omit to list label names. __name__ lists metric names."},
				"match":  map[string]any{"type": "string", "description": "Optional selector to narrow the series or streams."},
			}),
			required: []string{"source"},
			run:      runListLabels,
		},
	}
	out := make(map[string]investigationTool, len(tools))
	for _, t := range tools {
		out[t.name] = t
	}
	return out
}

// betaToolParams converts the tools to API params in a fixed order, so the cached prefix of
// every request is identical.
func betaToolParams(tools map[string]investigationTool) []anthropic.BetaToolUnionParam {
	names := make([]string, 0, len(tools))
	for n := range tools {
		names = append(names, n)
	}
	sort.Strings(names)
	params := make([]anthropic.BetaToolUnionParam, 0, len(names))
	for _, n := range names {
		t := tools[n]
		params = append(params, anthropic.BetaToolUnionParam{OfTool: &anthropic.BetaToolParam{
			Name:        t.name,
			Description: anthropic.String(t.description),
			InputSchema: anthropic.BetaToolInputSchemaParam{Properties: t.properties, Required: t.required},
			// The tool input streams as it is generated; callTool validates it.
			EagerInputStreaming: anthropic.Bool(true),
		}})
	}
	return params
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

type timeArgs struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// window resolves a tool's optional start/end against the investigation window.
func (inv *investigation) window(t timeArgs) (time.Time, time.Time, error) {
	start, end := inv.start, inv.end
	if t.Start != "" {
		v, err := time.Parse(time.RFC3339, t.Start)
		if err != nil {
			return start, end, fmt.Errorf("start is not an RFC 3339 time: %q", t.Start)
		}
		start = v
	}
	if t.End != "" {
		v, err := time.Parse(time.RFC3339, t.End)
		if err != nil {
			return start, end, fmt.Errorf("end is not an RFC 3339 time: %q", t.End)
		}
		end = v
	}
	if now := time.Now(); end.After(now) {
		end = now
	}
	if !end.After(start) {
		return start, end, errors.New("end must be after start")
	}
	if end.Sub(start) > maxInvestigationWindow {
		return start, end, fmt.Errorf("the range may be at most %s", maxInvestigationWindow)
	}
	return start, end, nil
}

// get performs a GET through the datasource proxy. Error bodies are returned in the error so
// the model can correct a bad query.
func (inv *investigation) get(ctx context.Context, reqURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	applyProxyAuth(req, inv.headers, inv.token)
	req.Header.Set("Accept", "application/json")
	resp, err := inv.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck
	body, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(strings.TrimSpace(string(body)), 600))
	}
	return body, nil
}

func decodeArgs(raw json.RawMessage, v any) error {
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("the input does not match the tool's schema: %v", err)
	}
	return nil
}

// autoStep picks a resolution of about 120 points, at least 15s.
func autoStep(start, end time.Time) time.Duration {
	step := end.Sub(start) / 120
	if step < 15*time.Second {
		step = 15 * time.Second
	}
	return step.Round(time.Second)
}

// ---------------------------------------------------------------------------
// Prometheus-style responses (metrics, and Loki metric queries)
// ---------------------------------------------------------------------------

type promStyleResponse struct {
	Status string `json:"status"`
	Error  string `json:"error"`
	Data   struct {
		ResultType string          `json:"resultType"`
		Result     json.RawMessage `json:"result"`
	} `json:"data"`
}

type promSeries struct {
	Metric map[string]string `json:"metric"`
	Values [][2]any          `json:"values"`
	Value  [2]any            `json:"value"`
}

func formatLabels(m map[string]string) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%q", k, truncate(m[k], 120)))
	}
	return "{" + strings.Join(parts, ", ") + "}"
}

func sampleValue(v [2]any) (time.Time, float64, bool) {
	ts, ok := v[0].(float64)
	if !ok {
		return time.Time{}, 0, false
	}
	s, ok := v[1].(string)
	if !ok {
		return time.Time{}, 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return time.Time{}, 0, false
	}
	sec, frac := math.Modf(ts)
	return time.Unix(int64(sec), int64(frac*1e9)).UTC(), f, true
}

func fmtNum(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 0):
		return fmt.Sprint(f)
	case f == math.Trunc(f) && math.Abs(f) < 1e15:
		return strconv.FormatFloat(f, 'f', 0, 64)
	default:
		return strconv.FormatFloat(f, 'g', 5, 64)
	}
}

// formatPromStyle renders a matrix or vector result.
func formatPromStyle(body []byte) (string, error) {
	var resp promStyleResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", fmt.Errorf("unexpected response: %v", err)
	}
	if resp.Status == "error" {
		return "", errors.New(resp.Error)
	}
	var b strings.Builder
	switch resp.Data.ResultType {
	case "matrix", "vector":
		var series []promSeries
		if err := json.Unmarshal(resp.Data.Result, &series); err != nil {
			return "", fmt.Errorf("unexpected result: %v", err)
		}
		if len(series) == 0 {
			return "No series matched.", nil
		}
		fmt.Fprintf(&b, "%d series", len(series))
		if len(series) > maxToolSeries {
			fmt.Fprintf(&b, " (showing %d; aggregate further to see the rest)", maxToolSeries)
			series = series[:maxToolSeries]
		}
		b.WriteString(".\n")
		for _, s := range series {
			b.WriteString(formatLabels(s.Metric))
			if resp.Data.ResultType == "vector" {
				if t, v, ok := sampleValue(s.Value); ok {
					fmt.Fprintf(&b, " = %s @ %s\n", fmtNum(v), t.Format(time.RFC3339))
				} else {
					b.WriteString(" = (no value)\n")
				}
				continue
			}
			b.WriteString(summariseSeries(s.Values))
		}
	case "scalar", "string":
		var v [2]any
		if err := json.Unmarshal(resp.Data.Result, &v); err == nil {
			fmt.Fprintf(&b, "%v @ %v\n", v[1], v[0])
		}
	default:
		return "", fmt.Errorf("unexpected result type %q", resp.Data.ResultType)
	}
	return b.String(), nil
}

// summariseSeries reduces a range series to its shape: first, last, min, max, mean and a few
// evenly spaced points.
func summariseSeries(values [][2]any) string {
	type pt struct {
		t time.Time
		v float64
	}
	pts := make([]pt, 0, len(values))
	for _, raw := range values {
		if t, v, ok := sampleValue(raw); ok {
			pts = append(pts, pt{t, v})
		}
	}
	if len(pts) == 0 {
		return ": no points\n"
	}
	minV, maxV, sum := pts[0].v, pts[0].v, 0.0
	for _, p := range pts {
		minV = math.Min(minV, p.v)
		maxV = math.Max(maxV, p.v)
		sum += p.v
	}
	var b strings.Builder
	fmt.Fprintf(&b, ": %d points, first %s, last %s, min %s, max %s, mean %s\n  samples:",
		len(pts), fmtNum(pts[0].v), fmtNum(pts[len(pts)-1].v), fmtNum(minV), fmtNum(maxV), fmtNum(sum/float64(len(pts))))
	n := maxToolPoints
	if len(pts) < n {
		n = len(pts)
	}
	for i := 0; i < n; i++ {
		idx := 0
		if n > 1 {
			idx = i * (len(pts) - 1) / (n - 1)
		}
		fmt.Fprintf(&b, " %s=%s", pts[idx].t.Format("15:04:05"), fmtNum(pts[idx].v))
	}
	b.WriteString("\n")
	return b.String()
}

// ---------------------------------------------------------------------------
// query_metrics
// ---------------------------------------------------------------------------

func runQueryMetrics(ctx context.Context, inv *investigation, raw json.RawMessage) (string, error) {
	var args struct {
		Query   string `json:"query"`
		Instant bool   `json:"instant"`
		Step    string `json:"step"`
		timeArgs
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Query) == "" {
		return "", errors.New("query is required")
	}
	base := inv.app.proxyURL(inv.app.settings.MetricsDataSource.Resolve(inv.env).UID)
	if base == "" {
		return "", errors.New("no metrics datasource is configured")
	}
	start, end, err := inv.window(args.timeArgs)
	if err != nil {
		return "", err
	}
	q := url.Values{"query": {args.Query}}
	path := "/api/v1/query_range"
	if args.Instant {
		path = "/api/v1/query"
		q.Set("time", strconv.FormatInt(end.Unix(), 10))
	} else {
		step := autoStep(start, end)
		if args.Step != "" {
			d, err := time.ParseDuration(args.Step)
			if err != nil || d <= 0 {
				return "", fmt.Errorf("step is not a duration: %q", args.Step)
			}
			step = d
		}
		q.Set("start", strconv.FormatInt(start.Unix(), 10))
		q.Set("end", strconv.FormatInt(end.Unix(), 10))
		q.Set("step", strconv.FormatFloat(step.Seconds(), 'f', -1, 64))
	}
	body, err := inv.get(ctx, base+path+"?"+q.Encode())
	if err != nil {
		return "", err
	}
	return formatPromStyle(body)
}

// ---------------------------------------------------------------------------
// query_logs
// ---------------------------------------------------------------------------

type lokiStream struct {
	Stream map[string]string `json:"stream"`
	Values [][2]string       `json:"values"`
}

func runQueryLogs(ctx context.Context, inv *investigation, raw json.RawMessage) (string, error) {
	var args struct {
		Query     string `json:"query"`
		Limit     int    `json:"limit"`
		Direction string `json:"direction"`
		timeArgs
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Query) == "" {
		return "", errors.New("query is required")
	}
	base := inv.app.lokiURL(inv.env)
	if base == "" {
		return "", errors.New("no logs datasource is configured")
	}
	start, end, err := inv.window(args.timeArgs)
	if err != nil {
		return "", err
	}
	limit := args.Limit
	if limit <= 0 {
		limit = defaultLogLines
	}
	if limit > maxLogLines {
		limit = maxLogLines
	}
	direction := "backward"
	if args.Direction == "forward" {
		direction = "forward"
	}
	q := url.Values{
		"query":     {args.Query},
		"start":     {strconv.FormatInt(start.UnixNano(), 10)},
		"end":       {strconv.FormatInt(end.UnixNano(), 10)},
		"limit":     {strconv.Itoa(limit)},
		"direction": {direction},
		"step":      {strconv.FormatFloat(autoStep(start, end).Seconds(), 'f', -1, 64)},
	}
	body, err := inv.get(ctx, base+"/loki/api/v1/query_range?"+q.Encode())
	if err != nil {
		return "", err
	}
	var resp promStyleResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", fmt.Errorf("unexpected response: %v", err)
	}
	if resp.Data.ResultType != "streams" {
		return formatPromStyle(body)
	}
	var streams []lokiStream
	if err := json.Unmarshal(resp.Data.Result, &streams); err != nil {
		return "", fmt.Errorf("unexpected result: %v", err)
	}
	return formatStreams(streams), nil
}

func formatStreams(streams []lokiStream) string {
	if len(streams) == 0 {
		return "No log lines matched."
	}
	total := 0
	for _, s := range streams {
		total += len(s.Values)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d lines in %d streams.\n", total, len(streams))
	for _, s := range streams {
		b.WriteString("\nStream " + formatLabels(s.Stream) + "\n")
		for _, v := range s.Values {
			ns, err := strconv.ParseInt(v[0], 10, 64)
			ts := v[0]
			if err == nil {
				ts = time.Unix(0, ns).UTC().Format("2006-01-02T15:04:05.000Z")
			}
			fmt.Fprintf(&b, "%s %s\n", ts, truncate(strings.TrimSpace(v[1]), maxLogLineChars))
		}
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// search_traces
// ---------------------------------------------------------------------------

type otlpAttr struct {
	Key   string `json:"key"`
	Value struct {
		StringValue *string  `json:"stringValue"`
		IntValue    any      `json:"intValue"`
		DoubleValue *float64 `json:"doubleValue"`
		BoolValue   *bool    `json:"boolValue"`
	} `json:"value"`
}

func (a otlpAttr) String() string {
	switch {
	case a.Value.StringValue != nil:
		return *a.Value.StringValue
	case a.Value.IntValue != nil:
		return fmt.Sprint(a.Value.IntValue)
	case a.Value.DoubleValue != nil:
		return fmtNum(*a.Value.DoubleValue)
	case a.Value.BoolValue != nil:
		return strconv.FormatBool(*a.Value.BoolValue)
	}
	return ""
}

func attrsString(attrs []otlpAttr, keep func(string) bool) string {
	parts := []string{}
	for _, a := range attrs {
		if keep != nil && !keep(a.Key) {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=%q", a.Key, truncate(a.String(), 200)))
	}
	return strings.Join(parts, " ")
}

func parseNanos(v any) int64 {
	switch x := v.(type) {
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	case float64:
		return int64(x)
	}
	return 0
}

func runSearchTraces(ctx context.Context, inv *investigation, raw json.RawMessage) (string, error) {
	var args struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
		timeArgs
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Query) == "" {
		return "", errors.New("query is required")
	}
	base := inv.app.tempoURL(inv.env)
	if base == "" {
		return "", errors.New("no traces datasource is configured")
	}
	start, end, err := inv.window(args.timeArgs)
	if err != nil {
		return "", err
	}
	limit := args.Limit
	if limit <= 0 {
		limit = defaultTraceResults
	}
	if limit > maxTraceResults {
		limit = maxTraceResults
	}
	q := url.Values{
		"q":     {args.Query},
		"limit": {strconv.Itoa(limit)},
		"spss":  {"3"},
		"start": {strconv.FormatInt(start.Unix(), 10)},
		"end":   {strconv.FormatInt(end.Unix(), 10)},
	}
	body, err := inv.get(ctx, base+"/api/search?"+q.Encode())
	if err != nil {
		return "", err
	}
	var resp struct {
		Traces []struct {
			TraceID           string `json:"traceID"`
			RootServiceName   string `json:"rootServiceName"`
			RootTraceName     string `json:"rootTraceName"`
			StartTimeUnixNano any    `json:"startTimeUnixNano"`
			DurationMs        int64  `json:"durationMs"`
			SpanSets          []struct {
				Spans []struct {
					SpanID            string     `json:"spanID"`
					Name              string     `json:"name"`
					StartTimeUnixNano any        `json:"startTimeUnixNano"`
					DurationNanos     any        `json:"durationNanos"`
					Attributes        []otlpAttr `json:"attributes"`
				} `json:"spans"`
				Matched int `json:"matched"`
			} `json:"spanSets"`
		} `json:"traces"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", fmt.Errorf("unexpected response: %v", err)
	}
	if len(resp.Traces) == 0 {
		return "No traces matched.", nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d traces.\n", len(resp.Traces))
	for _, t := range resp.Traces {
		started := time.Unix(0, parseNanos(t.StartTimeUnixNano)).UTC().Format(time.RFC3339)
		fmt.Fprintf(&b, "\ntrace %s: root %s %q, started %s, %dms\n", t.TraceID, t.RootServiceName, t.RootTraceName, started, t.DurationMs)
		for _, ss := range t.SpanSets {
			for _, sp := range ss.Spans {
				fmt.Fprintf(&b, "  span %s %q %sms %s\n", sp.SpanID, sp.Name,
					fmtNum(float64(parseNanos(sp.DurationNanos))/1e6), attrsString(sp.Attributes, nil))
			}
			if ss.Matched > len(ss.Spans) {
				fmt.Fprintf(&b, "  (%d spans matched in this trace)\n", ss.Matched)
			}
		}
	}
	return b.String(), nil
}

// ---------------------------------------------------------------------------
// get_trace
// ---------------------------------------------------------------------------

var traceIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{1,32}$`)

type otlpSpan struct {
	SpanID            string     `json:"spanId"`
	ParentSpanID      string     `json:"parentSpanId"`
	Name              string     `json:"name"`
	Kind              any        `json:"kind"`
	StartTimeUnixNano any        `json:"startTimeUnixNano"`
	EndTimeUnixNano   any        `json:"endTimeUnixNano"`
	Attributes        []otlpAttr `json:"attributes"`
	Status            struct {
		Code    any    `json:"code"`
		Message string `json:"message"`
	} `json:"status"`
	Events []struct {
		Name       string     `json:"name"`
		Attributes []otlpAttr `json:"attributes"`
	} `json:"events"`
}

type otlpResourceSpans struct {
	Resource struct {
		Attributes []otlpAttr `json:"attributes"`
	} `json:"resource"`
	ScopeSpans []struct {
		Spans []otlpSpan `json:"spans"`
	} `json:"scopeSpans"`
	InstrumentationLibrarySpans []struct {
		Spans []otlpSpan `json:"spans"`
	} `json:"instrumentationLibrarySpans"`
}

// keyTraceAttrs are the span attributes worth showing when summarising a trace.
var keyTraceAttrs = map[string]bool{
	"http.route": true, "http.request.method": true, "http.method": true, "http.response.status_code": true,
	"http.status_code": true, "url.full": true, "url.path": true, "server.address": true, "peer.service": true,
	"db.system": true, "db.system.name": true, "db.statement": true, "db.query.text": true, "db.operation.name": true,
	"rpc.service": true, "rpc.method": true, "messaging.system": true, "messaging.destination.name": true,
	"error.type": true, "exception.type": true, "exception.message": true,
}

func runGetTrace(ctx context.Context, inv *investigation, raw json.RawMessage) (string, error) {
	var args struct {
		TraceID string `json:"trace_id"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	id := strings.TrimSpace(args.TraceID)
	if !traceIDPattern.MatchString(id) {
		return "", fmt.Errorf("not a trace id: %q", args.TraceID)
	}
	base := inv.app.tempoURL(inv.env)
	if base == "" {
		return "", errors.New("no traces datasource is configured")
	}
	body, err := inv.get(ctx, base+"/api/v2/traces/"+id)
	var batches []otlpResourceSpans
	if err == nil {
		var v2 struct {
			Trace struct {
				ResourceSpans []otlpResourceSpans `json:"resourceSpans"`
			} `json:"trace"`
		}
		if jerr := json.Unmarshal(body, &v2); jerr == nil {
			batches = v2.Trace.ResourceSpans
		}
	}
	if err != nil || len(batches) == 0 {
		body, err = inv.get(ctx, base+"/api/traces/"+id)
		if err != nil {
			return "", err
		}
		var v1 struct {
			Batches       []otlpResourceSpans `json:"batches"`
			ResourceSpans []otlpResourceSpans `json:"resourceSpans"`
		}
		if err := json.Unmarshal(body, &v1); err != nil {
			return "", fmt.Errorf("unexpected response: %v", err)
		}
		batches = make([]otlpResourceSpans, 0, len(v1.Batches)+len(v1.ResourceSpans))
		batches = append(batches, v1.Batches...)
		batches = append(batches, v1.ResourceSpans...)
	}
	return summariseTrace(id, batches), nil
}

type flatSpan struct {
	service string
	span    otlpSpan
	start   int64
	dur     int64
	isErr   bool
}

func summariseTrace(id string, batches []otlpResourceSpans) string {
	var spans []flatSpan
	services := map[string]int{}
	for _, rs := range batches {
		svc := ""
		for _, a := range rs.Resource.Attributes {
			if a.Key == "service.name" {
				svc = a.String()
			}
		}
		all := []otlpSpan{}
		for _, ss := range rs.ScopeSpans {
			all = append(all, ss.Spans...)
		}
		for _, ss := range rs.InstrumentationLibrarySpans {
			all = append(all, ss.Spans...)
		}
		for _, sp := range all {
			st, en := parseNanos(sp.StartTimeUnixNano), parseNanos(sp.EndTimeUnixNano)
			code := fmt.Sprint(sp.Status.Code)
			spans = append(spans, flatSpan{
				service: svc, span: sp, start: st, dur: en - st,
				isErr: code == "STATUS_CODE_ERROR" || code == "2",
			})
			services[svc]++
		}
	}
	if len(spans) == 0 {
		return "The trace " + id + " was not found or has no spans."
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	first, last := spans[0].start, spans[0].start+spans[0].dur
	for _, s := range spans {
		if s.start+s.dur > last {
			last = s.start + s.dur
		}
	}

	var b strings.Builder
	svcNames := make([]string, 0, len(services))
	for s, n := range services {
		svcNames = append(svcNames, fmt.Sprintf("%s (%d)", s, n))
	}
	sort.Strings(svcNames)
	fmt.Fprintf(&b, "trace %s: %d spans over %sms, started %s. Services: %s.\n", id, len(spans),
		fmtNum(float64(last-first)/1e6), time.Unix(0, first).UTC().Format(time.RFC3339Nano), strings.Join(svcNames, ", "))

	line := func(s flatSpan) string {
		return fmt.Sprintf("  %s %q %sms (+%sms) %s", s.service, s.span.Name, fmtNum(float64(s.dur)/1e6),
			fmtNum(float64(s.start-first)/1e6), attrsString(s.span.Attributes, func(k string) bool { return keyTraceAttrs[k] }))
	}
	for _, s := range spans {
		if s.span.ParentSpanID == "" {
			b.WriteString("Root:\n" + line(s) + "\n")
			break
		}
	}

	var errs []flatSpan
	for _, s := range spans {
		if s.isErr {
			errs = append(errs, s)
		}
	}
	if len(errs) > 0 {
		fmt.Fprintf(&b, "Spans with an error status (%d):\n", len(errs))
		for i, s := range errs {
			if i == 15 {
				fmt.Fprintf(&b, "  ... and %d more\n", len(errs)-15)
				break
			}
			b.WriteString(line(s))
			if s.span.Status.Message != "" {
				fmt.Fprintf(&b, " status=%q", truncate(s.span.Status.Message, 300))
			}
			for _, ev := range s.span.Events {
				if ev.Name == "exception" {
					fmt.Fprintf(&b, " exception: %s", attrsString(ev.Attributes, func(k string) bool {
						return k == "exception.type" || k == "exception.message"
					}))
				}
			}
			b.WriteString("\n")
		}
	} else {
		b.WriteString("No span has an error status.\n")
	}

	slow := append([]flatSpan(nil), spans...)
	sort.Slice(slow, func(i, j int) bool { return slow[i].dur > slow[j].dur })
	if len(slow) > 15 {
		slow = slow[:15]
	}
	b.WriteString("Slowest spans:\n")
	for _, s := range slow {
		b.WriteString(line(s) + "\n")
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// list_labels
// ---------------------------------------------------------------------------

var labelNamePattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

func runListLabels(ctx context.Context, inv *investigation, raw json.RawMessage) (string, error) {
	var args struct {
		Source string `json:"source"`
		Label  string `json:"label"`
		Match  string `json:"match"`
		timeArgs
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if args.Label != "" && !labelNamePattern.MatchString(args.Label) {
		return "", fmt.Errorf("not a label name: %q", args.Label)
	}
	start, end, err := inv.window(args.timeArgs)
	if err != nil {
		return "", err
	}

	var reqURL string
	switch args.Source {
	case "metrics":
		base := inv.app.proxyURL(inv.app.settings.MetricsDataSource.Resolve(inv.env).UID)
		if base == "" {
			return "", errors.New("no metrics datasource is configured")
		}
		q := url.Values{"start": {strconv.FormatInt(start.Unix(), 10)}, "end": {strconv.FormatInt(end.Unix(), 10)}}
		if args.Match != "" {
			q.Set("match[]", args.Match)
		}
		path := "/api/v1/labels"
		if args.Label != "" {
			path = "/api/v1/label/" + url.PathEscape(args.Label) + "/values"
		}
		reqURL = base + path + "?" + q.Encode()
	case "logs":
		base := inv.app.lokiURL(inv.env)
		if base == "" {
			return "", errors.New("no logs datasource is configured")
		}
		q := url.Values{"start": {strconv.FormatInt(start.UnixNano(), 10)}, "end": {strconv.FormatInt(end.UnixNano(), 10)}}
		if args.Match != "" {
			q.Set("query", args.Match)
		}
		path := "/loki/api/v1/labels"
		if args.Label != "" {
			path = "/loki/api/v1/label/" + url.PathEscape(args.Label) + "/values"
		}
		reqURL = base + path + "?" + q.Encode()
	default:
		return "", errors.New(`source must be "metrics" or "logs"`)
	}

	body, err := inv.get(ctx, reqURL)
	if err != nil {
		return "", err
	}
	var resp struct {
		Status string   `json:"status"`
		Error  string   `json:"error"`
		Data   []string `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", fmt.Errorf("unexpected response: %v", err)
	}
	if resp.Status == "error" {
		return "", errors.New(resp.Error)
	}
	sort.Strings(resp.Data)
	what := "label names"
	if args.Label != "" {
		what = "values of " + args.Label
	}
	if len(resp.Data) == 0 {
		return "No " + what + " found.", nil
	}
	shown := resp.Data
	note := ""
	if len(shown) > maxLabelValues {
		shown = shown[:maxLabelValues]
		note = fmt.Sprintf(" (showing %d; use match to narrow)", maxLabelValues)
	}
	return fmt.Sprintf("%d %s%s:\n%s", len(resp.Data), what, note, strings.Join(shown, "\n")), nil
}
