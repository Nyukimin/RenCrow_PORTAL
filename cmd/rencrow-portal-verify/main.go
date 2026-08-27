package main

import (
	"os"

	"github.com/Nyukimin/RenCrow_PORTAL/internal/verify"
)

func main() {
	os.Exit(verify.Main(os.Args[1:], os.Stdout, os.Stderr))
}
