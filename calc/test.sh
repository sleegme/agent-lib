#!/usr/bin/env bash
# test.sh -- test suite for ntg-calc: CLI cases plus one MCP stdio round trip.
# Usage: make && ./test.sh
set -u
cd "$(dirname "$0")"

BIN=./ntg-calc
pass=0
fail=0

if [ ! -x "$BIN" ]; then
    echo "error: $BIN not found -- run make first" >&2
    exit 2
fi

# ok <expression> <expected stdout>
ok() {
    local out rc
    out=$("$BIN" "$1" 2>/dev/null)
    rc=$?
    if [ "$rc" -eq 0 ] && [ "$out" = "$2" ]; then
        pass=$((pass + 1))
        printf 'ok   %-28s -> %s\n' "$1" "$out"
    else
        fail=$((fail + 1))
        printf 'FAIL %-28s -> rc=%d out=[%s] want=[%s]\n' "$1" "$rc" "$out" "$2"
    fi
}

# bad <expression> <expected stderr substring>
bad() {
    local out rc
    out=$("$BIN" "$1" 2>&1 >/dev/null)
    rc=$?
    if [ "$rc" -ne 0 ] && [[ "$out" == *"$2"* ]]; then
        pass=$((pass + 1))
        printf 'ok   %-28s -> %s\n' "$1" "$out"
    else
        fail=$((fail + 1))
        printf 'FAIL %-28s -> rc=%d err=[%s] want substring [%s]\n' "$1" "$rc" "$out" "$2"
    fi
}

echo "=== CLI: exact integer arithmetic (__int128) ==="
ok '1+1' '2'
ok '2*3+4' '10'
ok '10-3*2' '4'
ok '(1+2)*3' '9'
ok '2^10' '1024'
ok '2^3^2' '512'
ok '-2^2' '-4'
ok '--5' '5'
ok '8/2' '4'
ok '17%5' '2'
ok '-7 % 3' '-1'
ok '7 % -3' '1'
ok '123456789*987654321' '121932631112635269'
ok '2^100' '1267650600228229401496703205376'
ok '1_000_000+1' '1000001'
ok '1_000*2' '2000'

echo
echo "=== CLI: integer overflow falls back to float and says so ==="
ok '2^127' '1.7014118346e+38 (approximate: integer overflow, computed as floating point)'
ok '2^200' '1.60693804426e+60 (approximate: integer overflow, computed as floating point)'

echo
echo "=== CLI: floating point ==="
ok '7/2' '3.5'
ok '1e3' '1000'
ok '0.1+0.2' '0.3'
ok '1/3' '0.333333333333'
ok 'sqrt(2)' '1.41421356237'
ok '2^0.5' '1.41421356237'
ok '2^-1' '0.5'
ok '5.5%2' '1.5'
ok 'pi' '3.14159265359'
ok 'e' '2.71828182846'
ok 'e^2' '7.38905609893'
ok 'exp(1)' '2.71828182846'
ok 'ln(e)' '1'
ok 'log10(1000)' '3'
ok 'log2(8)' '3'
ok 'tan(0)' '0'
ok 'abs(-5)' '5'
ok 'floor(2.7)+ceil(2.1)' '5'
ok 'round(2.5)' '3'
ok 'min(3,7)' '3'
ok 'max(3,7,5)' '7'
ok 'sqrt(-1)' 'nan'

echo
echo "=== CLI: errors (exit status 1, message on stderr) ==="
bad '1/0' 'division by zero'
bad '4%0' 'modulo by zero'
bad '2+' 'unexpected end of expression'
bad '(1+2' "missing ')'"
bad 'foo(1)' "unknown function 'foo'"
bad '2 & 3' "unexpected trailing input starting with '&'"
bad '1e' "unexpected trailing input starting with 'e'"
bad '3 4' 'unexpected trailing input'
bad '()' "unexpected character ')'"
bad '' 'empty expression'
bad '1.2.3' 'unexpected trailing input'
bad '1_' 'invalid number literal'
bad 'min(1)' 'at least 2 arguments'
bad '2+*3' "unexpected character '*'"
bad 'bogus' "unknown identifier 'bogus'"

echo
echo "=== CLI: multi-statement programs ==="

# multi <label> <expected stdout> <args...>
multi() {
    local label=$1 want=$2
    shift 2
    local out rc
    out=$("$BIN" "$@" 2>/dev/null)
    rc=$?
    if [ "$rc" -eq 0 ] && [ "$out" = "$want" ]; then
        pass=$((pass + 1))
        printf 'ok   %-28s -> %s\n' "$label" "$(printf '%s' "$out" | tr '\n' '|')"
    else
        fail=$((fail + 1))
        printf 'FAIL %-28s -> rc=%d out=[%s] want=[%s]\n' "$label" "$rc" "$out" "$want"
    fi
}

# badmulti <label> <expected stderr substring> <args...>
# Asserts exit status 1, the expected message, and no partial stdout.
badmulti() {
    local label=$1 want=$2
    shift 2
    local errfile out rc err
    errfile=$(mktemp)
    out=$("$BIN" "$@" 2>"$errfile")
    rc=$?
    err=$(cat "$errfile")
    rm -f "$errfile"
    if [ "$rc" -eq 1 ] && [ -z "$out" ] && [[ "$err" == *"$want"* ]]; then
        pass=$((pass + 1))
        printf 'ok   %-28s -> %s\n' "$label" "$err"
    else
        fail=$((fail + 1))
        printf 'FAIL %-28s -> rc=%d out=[%s] err=[%s] want substring [%s]\n' \
            "$label" "$rc" "$out" "$err" "$want"
    fi
}

# the N2 benchmark question in one call: 5.2389652 + 4.0411668 = 9.280132
multi 'cost calc (3 stmts)' "$(printf 'in = 5.2389652\nout = 4.0411668\nin+out = 9.280132\n=> 9.280132')" \
      'in=3742118*1.40/1e6; out=918447*4.40/1e6; in+out'

# integer-valued variables keep exact __int128 semantics
multi 'exact int variable' "$(printf 'a = 2305843009213693951\na*3 = 6917529027641081853\n=> 6917529027641081853')" \
      'a=2^61-1; a*3'
multi 'exact int, 2^100' "$(printf 'a = 1267650600228229401496703205376\nb = 2535301200456458802993406410752\na+b = 3802951800684688204490109616128\n=> 3802951800684688204490109616128')" \
      'a=2^100; b=a*2; a+b'

# several CLI arguments are statements, evaluated in order
multi 'multiple args' "$(printf 'a = 5\na*2 = 10\na+7 = 12\n=> 12')" 'a=5' 'a*2' 'a+7'

# statements separated by newlines inside one argument
multi 'newline separated' "$(printf 'x = 10\ny = 20\nx+y = 30\n=> 30')" "$(printf 'x=10\ny=20\nx+y')"

# a single assignment uses the structured output
multi 'single assignment' "$(printf 'a = 5\n=> 5')" 'a=5'

# single expression (also with a trailing ';') keeps the bare-value output
multi 'single expr unchanged' '2' '1+1'
multi 'single expr + empty stmt' '2' '1+1;'

# an error anywhere aborts with 'error in statement N:' and no partial stdout
badmulti 'error in statement 2' 'error in statement 2: division by zero' 'a=1; b=1/0'
badmulti 'error in statement 3' "error in statement 3: unknown identifier 'nope'" '1; a=2; a+nope'
badmulti 'reserved constant' "error in statement 1: cannot assign to reserved name 'pi'" 'pi = 3; 2'
badmulti 'reserved function' "error in statement 1: cannot assign to reserved name 'sqrt'" 'sqrt = 3'

# --help: exactly six lines and a multi-statement example
help_out=$("$BIN" --help)
help_lines=$(printf '%s\n' "$help_out" | wc -l)
if [ "$help_lines" -eq 6 ] && [[ "$help_out" == *"ntg-calc"* ]] && [[ "$help_out" == *"in+out'"* ]]; then
    pass=$((pass + 1))
    printf 'ok   %-28s -> %s lines\n' '--help' "$help_lines"
else
    fail=$((fail + 1))
    printf 'FAIL %-28s -> %s lines, out=[%s]\n' '--help' "$help_lines" "$help_out"
fi

echo
echo "=== MCP stdio round trip ==="
mcp_out=$(mktemp)
trap 'rm -f "$mcp_out"' EXIT

{
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
    printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"calc","arguments":{"expression":"2+2*2"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"calc","arguments":{"expression":"1/0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"calc","arguments":{"expression":"1/3","precision":5}}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":"six","method":"tools/call","params":{"name":"calc","arguments":{"expression":"2^200"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":7,"method":"bogus/method"}'
    printf '%s\n' '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"nope","arguments":{}}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"calc","arguments":{"precision":99}}}'
    printf '%s\n' 'not json'
    printf '%s\n' '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"calc","arguments":{"expression":"\""}}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"calc","arguments":{"expression":"1/3","precision":0}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"calc","arguments":{"expression":"2^100"}}}'
} | "$BIN" --mcp > "$mcp_out"

# mcp_has <label> <line number> <substring that must appear>
mcp_has() {
    local line
    line=$(sed -n "$2p" "$mcp_out")
    if [[ "$line" == *"$3"* ]]; then
        pass=$((pass + 1))
        printf 'ok   %-28s -> response %s\n' "$1" "$2"
    else
        fail=$((fail + 1))
        printf 'FAIL %-28s -> response %s: %s\n' "$1" "$2" "$line"
    fi
}

# mcp_lacks <label> <line number> <substring that must not appear>
mcp_lacks() {
    local line
    line=$(sed -n "$2p" "$mcp_out")
    if [[ "$line" != *"$3"* ]]; then
        pass=$((pass + 1))
        printf 'ok   %-28s -> response %s\n' "$1" "$2"
    else
        fail=$((fail + 1))
        printf 'FAIL %-28s -> response %s: %s\n' "$1" "$2" "$line"
    fi
}

count=$(wc -l < "$mcp_out")
if [ "$count" -eq 13 ]; then
    pass=$((pass + 1))
    echo 'ok   13 responses (2 notifications ignored)'
else
    fail=$((fail + 1))
    echo "FAIL expected 13 response lines, got $count"
fi

mcp_has  'initialize: protocol echo' 1 '"protocolVersion":"2025-03-26"'
mcp_has  'initialize: serverInfo'    1 '"serverInfo":{"name":"ntg-calc","version":"1.0.0"}'
mcp_has  'initialize: capabilities'  1 '"capabilities":{"tools":{}}'
mcp_has  'tools/list: calc tool'     2 '"name":"calc"'
mcp_has  'tools/list: inputSchema'   2 '"required":["expression"]'
mcp_has  'tools/list: precision'     2 '"minimum":0,"maximum":30,"default":12'
mcp_has  'tools/call: 2+2*2'         3 '"content":[{"type":"text","text":"6"}]'
mcp_lacks 'tools/call: no isError'   3 '"isError"'
mcp_has  'tools/call: div by zero'   4 '"isError":true'
mcp_has  'tools/call: error text'    4 'error: division by zero'
mcp_has  'tools/call: precision 5'   5 '"text":"0.33333"'
mcp_has  'tools/call: string id'     6 '"id":"six"'
mcp_has  'tools/call: approximate'   6 'approximate: integer overflow'
mcp_has  'unknown method'            7 '"error":{"code":-32601'
mcp_has  'unknown tool'              8 '"error":{"code":-32602'
mcp_has  'unknown tool: message'     8 'Unknown tool: nope'
mcp_has  'missing expression'        9 '"isError":true'
mcp_has  'invalid JSON'             10 '"code":-32700'
mcp_has  'JSON escaping'            11 "\"text\":\"error: unexpected character '\\\"'"
mcp_has  'precision 0 (1 digit)'    12 '"text":"0.3"'
mcp_has  'exact int ignores digits' 13 '"text":"1267650600228229401496703205376"'

echo
if [ "$fail" -eq 0 ]; then
    printf 'ALL PASS: %d assertions\n' "$pass"
    exit 0
fi
printf 'FAILURES: %d passed, %d failed\n' "$pass" "$fail"
exit 1
