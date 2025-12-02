package main

import (
	"log"

	"github.com/dosu-ai/dosu-cli/internal/cli"
)

func main() {
	if _, err := cli.Execute(); err != nil {
		log.Fatal(err)
	}
}
