//go:build js && wasm

package main

import (
	"encoding/json"
	"syscall/js"
)

// main exposes the solver to JavaScript and parks. The page calls
// gopackxSolve(requestJSON) from a Web Worker, so a long solve never
// blocks the UI thread.
func main() {
	js.Global().Set("gopackxSolve", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeString {
			return `{"ok":false,"error":"gopackxSolve expects one JSON string"}`
		}
		return solveJSON(args[0].String())
	}))
	js.Global().Set("gopackxInfo", js.FuncOf(func(js.Value, []js.Value) any {
		out, _ := json.Marshal(info())
		return string(out)
	}))
	select {}
}
