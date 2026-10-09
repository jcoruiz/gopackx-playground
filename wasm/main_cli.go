//go:build !(js && wasm)

package main

import (
	"fmt"
	"io"
	"os"
)

// main runs one request natively: go run . < request.json
// Handy to compare a browser result with native Go.
func main() {
	in, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(solveJSON(string(in)))
}
