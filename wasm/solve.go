package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"runtime"
	"runtime/debug"
	"strconv"
	"time"

	"github.com/jcoruiz/gopackx"
	"github.com/jcoruiz/gopackx/pkg/model"
	"github.com/jcoruiz/gopackx/pkg/packer"
	"github.com/jcoruiz/gopackx/pkg/placement"
	"github.com/jcoruiz/gopackx/pkg/solver"
	"github.com/jcoruiz/gopackx/pkg/stability"
	"github.com/jcoruiz/gopackx/pkg/strategy"
)

const (
	defaultTimeout = 5 * time.Second
	maxTimeout     = 60 * time.Second
	maxItems       = 5000
	maxBins        = 500
)

// BinSpec is a box type. In catalog modes it is a template the solver can
// instantiate as many times as needed; in fixed modes Qty instances exist.
type BinSpec struct {
	ID        string  `json:"id"`
	W         float64 `json:"w"`
	H         float64 `json:"h"`
	D         float64 `json:"d"`
	MaxWeight float64 `json:"maxWeight"`
	Cost      float64 `json:"cost"`
	Qty       int     `json:"qty"`
}

// ItemSpec is an item line. Qty > 1 expands into Qty items named ID-1..ID-n.
type ItemSpec struct {
	ID       string  `json:"id"`
	W        float64 `json:"w"`
	H        float64 `json:"h"`
	D        float64 `json:"d"`
	Weight   float64 `json:"weight"`
	Qty      int     `json:"qty"`
	Upright  bool    `json:"upright"`
	Fragile  bool    `json:"fragile"`
	LoadBear float64 `json:"loadBear"`
	Priority int     `json:"priority"`
	Group    string  `json:"group"`
}

// Request is what the page sends for one solve.
type Request struct {
	Mode         string     `json:"mode"`
	Engine       string     `json:"engine"`
	Strategy     string     `json:"strategy"`
	Stability    float64    `json:"stability"`
	Lookahead    bool       `json:"lookahead"`
	MaxIter      int        `json:"maxIter"`
	MaxNoImprove int        `json:"maxNoImprove"`
	BBFull       bool       `json:"bbFull"`
	TimeoutMs    int        `json:"timeoutMs"`
	Bins         []BinSpec  `json:"bins"`
	Items        []ItemSpec `json:"items"`
}

// PlacedItem is an item inside a bin. X, Y, Z is the corner closest to the
// origin and W, H, D the dimensions after rotation (Y is up).
type PlacedItem struct {
	ID       string  `json:"id"`
	Spec     int     `json:"spec"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Z        float64 `json:"z"`
	W        float64 `json:"w"`
	H        float64 `json:"h"`
	D        float64 `json:"d"`
	Rotation int     `json:"rotation"`
	Weight   float64 `json:"weight"`
	Support  float64 `json:"support"`
	Load     float64 `json:"load"`
}

// BinResult is one used bin.
type BinResult struct {
	ID        string       `json:"id"`
	Spec      int          `json:"spec"`
	W         float64      `json:"w"`
	H         float64      `json:"h"`
	D         float64      `json:"d"`
	MaxWeight float64      `json:"maxWeight"`
	Cost      float64      `json:"cost"`
	Weight    float64      `json:"weight"`
	VolumePct float64      `json:"volumePct"`
	Gravity   [4]float64   `json:"gravity"`
	Items     []PlacedItem `json:"items"`
}

// UnfittedItem is an item the solver could not place.
type UnfittedItem struct {
	ID   string `json:"id"`
	Spec int    `json:"spec"`
}

// Stats mirrors model.PackingStats.
type Stats struct {
	TotalBins     int     `json:"totalBins"`
	TotalItems    int     `json:"totalItems"`
	FittedItems   int     `json:"fittedItems"`
	UnfittedCount int     `json:"unfittedCount"`
	VolumeUsedPct float64 `json:"volumeUsedPct"`
	WeightUsedPct float64 `json:"weightUsedPct"`
	TotalCost     float64 `json:"totalCost"`
}

// Response is what the page gets back.
type Response struct {
	OK         bool           `json:"ok"`
	Error      string         `json:"error,omitempty"`
	ElapsedMs  float64        `json:"elapsedMs"`
	TimedOut   bool           `json:"timedOut"`
	Stats      Stats          `json:"stats"`
	Bins       []BinResult    `json:"bins"`
	Unfitted   []UnfittedItem `json:"unfitted"`
	UnusedBins int            `json:"unusedBins"`
}

// Info describes the build, shown in the page footer.
type Info struct {
	Library   string `json:"library"`
	GoVersion string `json:"goVersion"`
}

func info() Info {
	lib := "unknown"
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range bi.Deps {
			if dep.Path == "github.com/jcoruiz/gopackx" {
				lib = dep.Version
			}
		}
	}
	return Info{Library: lib, GoVersion: runtime.Version()}
}

func solveJSON(in string) string {
	var req Request
	var resp Response
	if err := json.Unmarshal([]byte(in), &req); err != nil {
		resp = Response{Error: "invalid request: " + err.Error()}
	} else {
		resp = solve(req)
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return `{"ok":false,"error":"cannot encode response"}`
	}
	return string(out)
}

// deadlineCtx expires by reading the clock on every Err call. Under
// GOOS=js there is a single thread and no preemption, so the timer behind
// context.WithTimeout would never fire while a solver is busy. gopackx only
// polls ctx.Err, which makes this enough.
type deadlineCtx struct {
	context.Context
	deadline time.Time
}

func (c deadlineCtx) Deadline() (time.Time, bool) { return c.deadline, true }

func (c deadlineCtx) Err() error {
	if time.Now().After(c.deadline) {
		return context.DeadlineExceeded
	}
	return nil
}

func solve(req Request) Response {
	if err := validate(req); err != nil {
		return Response{Error: err.Error()}
	}

	newEngine, err := engineFactory(req.Engine, req.Stability)
	if err != nil {
		return Response{Error: err.Error()}
	}
	st, err := parseStrategy(req.Strategy)
	if err != nil {
		return Response{Error: err.Error()}
	}

	items, itemSpec := expandItems(req.Items)
	timeout := defaultTimeout
	if req.TimeoutMs > 0 {
		timeout = min(time.Duration(req.TimeoutMs)*time.Millisecond, maxTimeout)
	}
	ctx := deadlineCtx{Context: context.Background(), deadline: time.Now().Add(timeout)}

	var (
		result  *model.Result
		binSpec func(*model.Bin) int
		offered int
	)
	start := time.Now()

	switch req.Mode {
	case "pack", "optimize", "trial", "metaheuristic":
		types := make([]*model.Bin, len(req.Bins))
		for i, b := range req.Bins {
			types[i] = newBin(b.ID, b)
		}
		binSpec = catalogSpec(req.Bins)

		switch req.Mode {
		case "pack":
			result, err = gopackx.Pack(ctx, types, items, gopackx.WithEngine(newEngine))
		case "optimize":
			result, err = gopackx.Pack(ctx, types, items, gopackx.WithEngine(newEngine), gopackx.Optimize())
		case "trial":
			opts := []solver.TrialOption{solver.TrialItemSort(st)}
			if req.Lookahead {
				opts = append(opts, solver.WithLookahead())
			}
			result, err = solver.NewTrialPacking(newEngine, opts...).Solve(ctx, types, items)
		case "metaheuristic":
			var opts []solver.MetaOption
			if req.MaxIter > 0 {
				opts = append(opts, solver.MetaMaxIter(req.MaxIter))
			}
			if req.MaxNoImprove > 0 {
				opts = append(opts, solver.MetaMaxNoImprove(req.MaxNoImprove))
			}
			result, err = solver.NewMetaheuristic(newEngine, opts...).Solve(ctx, types, items)
		}

	case "packer", "branchbound", "parallel":
		bins, specOf := expandBins(req.Bins)
		binSpec = func(b *model.Bin) int { return specOf[b.ID] }
		offered = len(bins)

		switch req.Mode {
		case "packer":
			p := packer.NewPacker(packer.WithStrategy(st), packer.WithPlacementEngine(newEngine()))
			for _, b := range bins {
				p.AddBin(b)
			}
			for _, it := range items {
				p.AddItem(it)
			}
			result, err = p.Pack(ctx)
		case "branchbound":
			var opts []solver.BBOption
			if req.BBFull {
				opts = append(opts, solver.BBFull())
			}
			result, err = solver.NewBranchBound(newEngine, opts...).Solve(ctx, bins, items)
		case "parallel":
			result, err = solver.NewParallel(parallelConfigs(req.Stability)...).Solve(ctx, bins, items)
		}

	default:
		return Response{Error: fmt.Sprintf("unknown mode %q", req.Mode)}
	}

	elapsed := time.Since(start)
	timedOut := errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil
	if err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return Response{Error: err.Error(), ElapsedMs: ms(elapsed)}
	}
	if result == nil {
		// The packer returns no partial result when the deadline passes.
		return Response{Error: "time limit reached before any solution", ElapsedMs: ms(elapsed), TimedOut: true}
	}

	return buildResponse(result, binSpec, itemSpec, offered, elapsed, timedOut)
}

func validate(req Request) error {
	if len(req.Bins) == 0 {
		return errors.New("add at least one box")
	}
	if len(req.Items) == 0 {
		return errors.New("add at least one item")
	}
	totalBins, totalItems := 0, 0
	for _, b := range req.Bins {
		if b.W <= 0 || b.H <= 0 || b.D <= 0 {
			return fmt.Errorf("box %q needs positive dimensions", b.ID)
		}
		if b.MaxWeight < 0 || b.Cost < 0 {
			return fmt.Errorf("box %q has a negative weight limit or cost", b.ID)
		}
		totalBins += max(b.Qty, 1)
	}
	for _, it := range req.Items {
		if it.W <= 0 || it.H <= 0 || it.D <= 0 {
			return fmt.Errorf("item %q needs positive dimensions", it.ID)
		}
		if it.Weight < 0 || it.LoadBear < 0 {
			return fmt.Errorf("item %q has a negative weight or load limit", it.ID)
		}
		totalItems += max(it.Qty, 1)
	}
	if totalItems > maxItems {
		return fmt.Errorf("%d items is above the playground limit of %d", totalItems, maxItems)
	}
	if totalBins > maxBins {
		return fmt.Errorf("%d boxes is above the playground limit of %d", totalBins, maxBins)
	}
	if req.Stability < 0 || req.Stability > 1 {
		return errors.New("stability must be between 0 and 1")
	}
	return nil
}

func engineFactory(name string, ratio float64) (func() placement.Engine, error) {
	stable := ratio > 0
	switch name {
	case "", "pivot":
		return func() placement.Engine {
			if stable {
				return placement.NewPivotEngine(placement.WithStability(ratio))
			}
			return placement.NewPivotEngine()
		}, nil
	case "extremepoint":
		return func() placement.Engine {
			if stable {
				return placement.NewExtremePointEngine(placement.WithEPStability(ratio))
			}
			return placement.NewExtremePointEngine()
		}, nil
	case "maxrects":
		return func() placement.Engine {
			if stable {
				return placement.NewMaxRectsEngine(placement.WithMaxRectsStability(ratio))
			}
			return placement.NewMaxRectsEngine()
		}, nil
	case "laff", "laff-fast":
		fast := name == "laff-fast"
		return func() placement.Engine {
			var opts []placement.LAFFOption
			if fast {
				opts = append(opts, placement.LAFFFast())
			}
			if stable {
				opts = append(opts, placement.WithLAFFStability(ratio))
			}
			return placement.NewLAFFEngine(opts...)
		}, nil
	}
	return nil, fmt.Errorf("unknown engine %q", name)
}

var strategies = map[string]strategy.Type{
	"BestFitDecreasing": strategy.BestFitDecreasing,
	"MinimizeBins":      strategy.MinimizeBins,
	"BestFit":           strategy.BestFit,
	"Greedy":            strategy.Greedy,
	"NextFit":           strategy.NextFit,
	"WorstFit":          strategy.WorstFit,
	"AlmostWorstFit":    strategy.AlmostWorstFit,
}

func parseStrategy(name string) (strategy.Type, error) {
	if name == "" {
		return strategy.BestFitDecreasing, nil
	}
	st, ok := strategies[name]
	if !ok {
		return 0, fmt.Errorf("unknown strategy %q", name)
	}
	return st, nil
}

// parallelConfigs returns nil (the library defaults) without stability, and
// the same five combinations with stability on otherwise.
func parallelConfigs(ratio float64) []solver.ParallelOption {
	if ratio <= 0 {
		return nil
	}
	combos := []struct {
		engine string
		st     strategy.Type
	}{
		{"pivot", strategy.BestFitDecreasing},
		{"pivot", strategy.MinimizeBins},
		{"extremepoint", strategy.BestFitDecreasing},
		{"laff", strategy.BestFitDecreasing},
		{"laff-fast", strategy.BestFitDecreasing},
	}
	opts := make([]solver.ParallelOption, len(combos))
	for i, c := range combos {
		f, _ := engineFactory(c.engine, ratio)
		opts[i] = solver.WithConfig(f, c.st)
	}
	return opts
}

func newBin(id string, b BinSpec) *model.Bin {
	var opts []model.BinOption
	if b.Cost > 0 {
		opts = append(opts, model.BinCost(b.Cost))
	}
	return model.NewBin(id, b.W, b.H, b.D, b.MaxWeight, opts...)
}

// expandBins creates Qty instances of each box for the fixed-bin modes.
func expandBins(specs []BinSpec) ([]*model.Bin, map[string]int) {
	var bins []*model.Bin
	specOf := map[string]int{}
	for i, s := range specs {
		n := max(s.Qty, 1)
		for k := 1; k <= n; k++ {
			id := s.ID
			if n > 1 {
				id = s.ID + " #" + strconv.Itoa(k)
			}
			id = unique(id, specOf)
			specOf[id] = i
			bins = append(bins, newBin(id, s))
		}
	}
	return bins, specOf
}

// catalogSpec maps a bin opened by TrialPacking or Metaheuristic ("<type>-<n>")
// back to its box type.
func catalogSpec(specs []BinSpec) func(*model.Bin) int {
	byID := map[string]int{}
	for i, s := range specs {
		if _, dup := byID[s.ID]; !dup {
			byID[s.ID] = i
		}
	}
	return func(b *model.Bin) int {
		if i, ok := byID[trimInstanceSuffix(b.ID)]; ok {
			return i
		}
		for i, s := range specs {
			if s.W == b.Width && s.H == b.Height && s.D == b.Depth && s.Cost == b.Cost {
				return i
			}
		}
		return -1
	}
}

// trimInstanceSuffix drops the "-<n>" the solvers append to a type ID.
func trimInstanceSuffix(id string) string {
	i := len(id)
	for i > 0 && id[i-1] >= '0' && id[i-1] <= '9' {
		i--
	}
	if i < len(id) && i > 0 && id[i-1] == '-' {
		return id[:i-1]
	}
	return id
}

func expandItems(specs []ItemSpec) ([]*model.Item, map[string]int) {
	var items []*model.Item
	specOf := map[string]int{}
	for i, s := range specs {
		var opts []model.ItemOption
		if s.Upright {
			opts = append(opts, model.ItemUpright())
		}
		if s.Fragile {
			opts = append(opts, model.ItemFragile())
		}
		if s.LoadBear > 0 {
			opts = append(opts, model.ItemLoadBear(s.LoadBear))
		}
		if s.Priority > 0 {
			opts = append(opts, model.ItemPriority(s.Priority))
		}
		if s.Group != "" {
			opts = append(opts, model.ItemGroup(s.Group))
		}
		n := max(s.Qty, 1)
		for k := 1; k <= n; k++ {
			id := s.ID
			if n > 1 {
				id = s.ID + "-" + strconv.Itoa(k)
			}
			id = unique(id, specOf)
			specOf[id] = i
			items = append(items, model.NewItem(id, s.W, s.H, s.D, s.Weight, opts...))
		}
	}
	return items, specOf
}

// unique appends a counter when an ID is already taken, so results can be
// traced back to their input line.
func unique(id string, taken map[string]int) string {
	if _, ok := taken[id]; !ok {
		return id
	}
	for n := 2; ; n++ {
		c := id + " (" + strconv.Itoa(n) + ")"
		if _, ok := taken[c]; !ok {
			return c
		}
	}
}

func buildResponse(r *model.Result, binSpec func(*model.Bin) int, itemSpec map[string]int, offered int, elapsed time.Duration, timedOut bool) Response {
	resp := Response{
		OK:        true,
		ElapsedMs: ms(elapsed),
		TimedOut:  timedOut,
		Stats: Stats{
			TotalBins:     r.Stats.TotalBins,
			TotalItems:    r.Stats.TotalItems,
			FittedItems:   r.Stats.FittedItems,
			UnfittedCount: r.Stats.UnfittedCount,
			VolumeUsedPct: round(r.Stats.VolumeUsedPct),
			WeightUsedPct: round(r.Stats.WeightUsedPct),
			TotalCost:     round(r.Stats.TotalCost),
		},
		Bins:     []BinResult{},
		Unfitted: []UnfittedItem{},
	}

	for _, b := range r.Bins {
		if len(b.Items) == 0 {
			continue
		}
		out := BinResult{
			ID:        b.ID,
			Spec:      binSpec(b),
			W:         b.Width,
			H:         b.Height,
			D:         b.Depth,
			MaxWeight: b.MaxWeight,
			Cost:      b.Cost,
			Weight:    round(b.TotalWeight()),
			VolumePct: round(b.VolumeUsedPct()),
			Gravity:   stability.GravityCenter(b.Items, b.Width, b.Depth),
			Items:     make([]PlacedItem, len(b.Items)),
		}
		for g := range out.Gravity {
			out.Gravity[g] = round(out.Gravity[g])
		}
		for i, it := range b.Items {
			dim := it.Dimension()
			out.Items[i] = PlacedItem{
				ID:       it.ID,
				Spec:     itemSpec[it.ID],
				X:        it.Position[0],
				Y:        it.Position[1],
				Z:        it.Position[2],
				W:        dim[0],
				H:        dim[1],
				D:        dim[2],
				Rotation: int(it.RotationType),
				Weight:   it.Weight,
				Support:  round(stability.SupportRatio(it, b.Items)),
				Load:     round(stability.WeightAbove(it, b.Items)),
			}
		}
		resp.Bins = append(resp.Bins, out)
	}
	if offered > 0 {
		resp.UnusedBins = offered - len(resp.Bins)
	}
	for _, it := range r.UnfittedItems {
		resp.Unfitted = append(resp.Unfitted, UnfittedItem{ID: it.ID, Spec: itemSpec[it.ID]})
	}
	return resp
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func round(v float64) float64 { return math.Round(v*1e4) / 1e4 }
