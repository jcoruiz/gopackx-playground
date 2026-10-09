package main

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

func officeOrder() Request {
	return Request{
		Bins: []BinSpec{
			{ID: "Mailer", W: 43, H: 34.5, D: 5, MaxWeight: 1, Qty: 2},
			{ID: "Small", W: 25, H: 20, D: 20, MaxWeight: 5, Qty: 2},
			{ID: "Medium", W: 30, H: 30, D: 25, MaxWeight: 10, Qty: 2},
			{ID: "Large", W: 40, H: 40, D: 30, MaxWeight: 20, Qty: 3},
		},
		Items: []ItemSpec{
			{ID: "Binder", W: 27, H: 8.5, D: 35.2, Weight: 0.395, Qty: 3},
			{ID: "Folder", W: 27, H: 9, D: 30.5, Weight: 0.415, Qty: 5},
			{ID: "Notebook", W: 28.5, H: 6.8, D: 29.4, Weight: 0.534, Qty: 4},
			{ID: "Paper ream", W: 23.5, H: 6, D: 34.5, Weight: 2.78, Qty: 3},
			{ID: "Bond paper", W: 28, H: 5, D: 22, Weight: 2.5, Qty: 2},
		},
	}
}

func constrained() Request {
	return Request{
		Bins: []BinSpec{{ID: "Van", W: 120, H: 100, D: 150, MaxWeight: 400, Qty: 2}},
		Items: []ItemSpec{
			{ID: "TV", W: 20, H: 60, D: 90, Weight: 12, Qty: 2, Upright: true},
			{ID: "Glassware", W: 30, H: 25, D: 30, Weight: 4, Qty: 4, Fragile: true},
			{ID: "Crate", W: 40, H: 30, D: 40, Weight: 18, Qty: 6, LoadBear: 30},
			{ID: "Books", W: 30, H: 20, D: 40, Weight: 15, Qty: 5, Priority: 1, Group: "office"},
		},
	}
}

var modes = []string{"pack", "optimize", "trial", "metaheuristic", "packer", "branchbound", "parallel"}
var engines = []string{"pivot", "extremepoint", "maxrects", "laff", "laff-fast"}

func TestAllModesAndEngines(t *testing.T) {
	for name, base := range map[string]Request{"office": officeOrder(), "constrained": constrained()} {
		for _, mode := range modes {
			for _, engine := range engines {
				for _, ratio := range []float64{0, 0.7} {
					req := base
					req.Mode, req.Engine, req.Stability, req.Lookahead = mode, engine, ratio, true
					req.TimeoutMs = 3000
					if mode == "branchbound" {
						req.TimeoutMs = 300
					}
					resp := solve(req)
					if !resp.OK {
						t.Errorf("%s/%s/%s/%.1f: %s", name, mode, engine, ratio, resp.Error)
						continue
					}
					checkGeometry(t, name+"/"+mode+"/"+engine, req, resp)
				}
			}
		}
	}
}

// checkGeometry repeats the basic invariants the page verifies.
func checkGeometry(t *testing.T, label string, req Request, resp Response) {
	t.Helper()
	const eps = 1e-6
	seen := map[string]bool{}
	_, specOf := expandItems(req.Items)
	for _, b := range resp.Bins {
		weight := 0.0
		for i, a := range b.Items {
			seen[a.ID] = true
			weight += a.Weight
			if a.X < -eps || a.Y < -eps || a.Z < -eps || a.X+a.W > b.W+eps || a.Y+a.H > b.H+eps || a.Z+a.D > b.D+eps {
				t.Errorf("%s: %s outside %s", label, a.ID, b.ID)
			}
			for _, c := range b.Items[i+1:] {
				if a.X < c.X+c.W-eps && c.X < a.X+a.W-eps &&
					a.Y < c.Y+c.H-eps && c.Y < a.Y+a.H-eps &&
					a.Z < c.Z+c.D-eps && c.Z < a.Z+a.D-eps {
					t.Errorf("%s: %s overlaps %s in %s", label, a.ID, c.ID, b.ID)
				}
			}
		}
		if weight > b.MaxWeight+eps {
			t.Errorf("%s: %s carries %.3f over %.3f", label, b.ID, weight, b.MaxWeight)
		}
	}
	for _, u := range resp.Unfitted {
		if seen[u.ID] {
			t.Errorf("%s: %s both placed and unfitted", label, u.ID)
		}
		seen[u.ID] = true
	}
	if len(seen) != len(specOf) {
		t.Errorf("%s: %d items accounted for, want %d", label, len(seen), len(specOf))
	}
	if resp.Stats.FittedItems+resp.Stats.UnfittedCount != resp.Stats.TotalItems {
		t.Errorf("%s: stats do not add up: %+v", label, resp.Stats)
	}
}

func TestCatalogBinsMapToTheirType(t *testing.T) {
	req := officeOrder()
	req.Mode = "optimize"
	resp := solve(req)
	if !resp.OK {
		t.Fatal(resp.Error)
	}
	for _, b := range resp.Bins {
		if b.Spec < 0 {
			t.Fatalf("bin %s has no type", b.ID)
		}
		s := req.Bins[b.Spec]
		if s.W != b.W || s.H != b.H || s.D != b.D {
			t.Errorf("bin %s mapped to %s", b.ID, s.ID)
		}
	}
}

func TestFixedModesReportUnusedBins(t *testing.T) {
	req := officeOrder()
	req.Mode = "packer"
	resp := solve(req)
	if !resp.OK {
		t.Fatal(resp.Error)
	}
	if got, want := resp.UnusedBins+len(resp.Bins), 9; got != want {
		t.Errorf("used+unused = %d, want %d", got, want)
	}
}

func TestDeadlineStopsBranchAndBound(t *testing.T) {
	req := Request{
		Mode:      "branchbound",
		BBFull:    true,
		TimeoutMs: 150,
		Bins:      []BinSpec{{ID: "Cube", W: 40, H: 40, D: 40, MaxWeight: 1000, Qty: 3}},
	}
	for i := range 14 {
		req.Items = append(req.Items, ItemSpec{ID: "Piece", W: float64(11 + i), H: float64(23 - i/2), D: float64(9 + 2*i%13), Weight: 1})
	}
	start := time.Now()
	resp := solve(req)
	if !resp.OK {
		t.Fatal(resp.Error)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("deadline of 150ms took %s", took)
	}
	if !resp.TimedOut {
		t.Errorf("expected the run to report a timeout")
	}
}

func TestDuplicateIDsStayTraceable(t *testing.T) {
	req := Request{
		Mode:  "pack",
		Bins:  []BinSpec{{ID: "Box", W: 50, H: 50, D: 50, MaxWeight: 100}},
		Items: []ItemSpec{{ID: "A", W: 10, H: 10, D: 10, Weight: 1}, {ID: "A", W: 20, H: 20, D: 20, Weight: 1}},
	}
	resp := solve(req)
	ids := map[string]int{}
	for _, b := range resp.Bins {
		for _, it := range b.Items {
			ids[it.ID] = it.Spec
		}
	}
	if len(ids) != 2 || ids["A"] != 0 || ids["A (2)"] != 1 {
		t.Errorf("ids = %v", ids)
	}
}

func TestRejectsBadInput(t *testing.T) {
	cases := map[string]Request{
		"no bins":    {Mode: "pack", Items: []ItemSpec{{ID: "a", W: 1, H: 1, D: 1}}},
		"no items":   {Mode: "pack", Bins: []BinSpec{{ID: "b", W: 1, H: 1, D: 1}}},
		"zero dim":   {Mode: "pack", Bins: []BinSpec{{ID: "b", W: 0, H: 1, D: 1}}, Items: []ItemSpec{{ID: "a", W: 1, H: 1, D: 1}}},
		"bad mode":   {Mode: "magic", Bins: []BinSpec{{ID: "b", W: 1, H: 1, D: 1}}, Items: []ItemSpec{{ID: "a", W: 1, H: 1, D: 1}}},
		"bad engine": {Mode: "pack", Engine: "x", Bins: []BinSpec{{ID: "b", W: 1, H: 1, D: 1}}, Items: []ItemSpec{{ID: "a", W: 1, H: 1, D: 1}}},
		"too many":   {Mode: "pack", Bins: []BinSpec{{ID: "b", W: 1, H: 1, D: 1}}, Items: []ItemSpec{{ID: "a", W: 1, H: 1, D: 1, Qty: maxItems + 1}}},
	}
	for name, req := range cases {
		if resp := solve(req); resp.OK || resp.Error == "" {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestSolveJSONRoundTrip(t *testing.T) {
	in, _ := json.Marshal(Request{Mode: "pack", Bins: officeOrder().Bins, Items: officeOrder().Items})
	var resp Response
	if err := json.Unmarshal([]byte(solveJSON(string(in))), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.OK || resp.Stats.TotalItems != 17 {
		t.Fatalf("resp = %+v", resp)
	}
	if out := solveJSON("{"); !strings.Contains(out, "invalid request") {
		t.Errorf("malformed JSON: %s", out)
	}
	for _, g := range resp.Bins[0].Gravity {
		if math.IsNaN(g) {
			t.Error("gravity is NaN")
		}
	}
}

func TestTrimInstanceSuffix(t *testing.T) {
	for in, want := range map[string]string{"Large-0": "Large", "Box-A-12": "Box-A", "Plain": "Plain", "Odd-": "Odd-", "-3": "", "7": "7"} {
		if got := trimInstanceSuffix(in); got != want {
			t.Errorf("trimInstanceSuffix(%q) = %q, want %q", in, got, want)
		}
	}
}
