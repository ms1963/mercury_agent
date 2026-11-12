// Example Mercury polyglot tool in Go: JSON args on stdin, JSON result on stdout.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	var args struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&args); err != nil {
		fmt.Printf(`{"content": "invalid input: %s", "isError": true}`, err)
		return
	}
	sum := sha256.Sum256([]byte(args.Text))
	out, _ := json.Marshal(map[string]string{"content": hex.EncodeToString(sum[:])})
	fmt.Println(string(out))
}
