// ntg-calc -- a small expression calculator with an MCP (stdio) server mode.
//
//   ntg-calc '<expr>' ...   evaluate statements, print results to stdout
//   ntg-calc --mcp          run a Model Context Protocol stdio server
//
// Build: make   (links statically when the toolchain supports it)
//
// Language: numbers (1, 1.5, .5, 1e3, 1_000), + - * / % ^ (right associative),
// unary -, parentheses, the functions
//   sqrt abs ln log10 log2 exp sin cos tan floor ceil round min max
// and the constants pi and e.
//
// Statements are separated by ';' or newlines, and every CLI argument is one
// or more statements, so a single call can do a whole computation:
//
//   ntg-calc 'in = 3742118*1.40/1e6; out = 918447*4.40/1e6; in+out'
//
// 'name = expr' assigns a variable (names match [a-zA-Z_][a-zA-Z0-9_]* and
// must not shadow the built-in functions or constants) for later statements to
// use.  Every statement prints one 'expr = value' line ('name = value' for
// assignments) and the final value is echoed on the last line as '=> value';
// a single expression statement keeps the old bare-value output.
//
// Integer-only expressions are evaluated exactly with __int128.  When an
// integer operation overflows 128 bits the value falls back to long double and
// the printed result is flagged as approximate.  Everything else (fractions,
// function calls, constants) is evaluated in long double.

#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

struct CalcError : std::runtime_error {
    explicit CalcError(const std::string& msg) : std::runtime_error(msg) {}
};

static std::string posError(size_t pos, const std::string& what) {
    return what + " at position " + std::to_string(pos + 1);
}

// ---------------------------------------------------------------------------
// values and arithmetic
// ---------------------------------------------------------------------------

static __int128 i128Max() { return (__int128)(((unsigned __int128)1 << 127) - 1); }
static __int128 i128Min() { return -i128Max() - 1; }

struct Value {
    bool isInt = true;   // true: exact __int128, false: long double
    bool approx = false; // true: result of an integer overflow fallback
    __int128 i = 0;
    long double f = 0;
};

static Value makeInt(__int128 v) {
    Value r;
    r.isInt = true;
    r.i = v;
    return r;
}

static Value makeFloat(long double v, bool approx = false) {
    Value r;
    r.isInt = false;
    r.approx = approx;
    r.f = v;
    return r;
}

static long double toFloat(const Value& v) { return v.isInt ? (long double)v.i : v.f; }

static Value addValues(const Value& a, const Value& b) {
    if (a.isInt && b.isInt) {
        __int128 r;
        if (!__builtin_add_overflow(a.i, b.i, &r)) return makeInt(r);
        return makeFloat((long double)a.i + (long double)b.i, true);
    }
    return makeFloat(toFloat(a) + toFloat(b), a.approx || b.approx);
}

static Value subValues(const Value& a, const Value& b) {
    if (a.isInt && b.isInt) {
        __int128 r;
        if (!__builtin_sub_overflow(a.i, b.i, &r)) return makeInt(r);
        return makeFloat((long double)a.i - (long double)b.i, true);
    }
    return makeFloat(toFloat(a) - toFloat(b), a.approx || b.approx);
}

static Value mulValues(const Value& a, const Value& b) {
    if (a.isInt && b.isInt) {
        __int128 r;
        if (!__builtin_mul_overflow(a.i, b.i, &r)) return makeInt(r);
        return makeFloat((long double)a.i * (long double)b.i, true);
    }
    return makeFloat(toFloat(a) * toFloat(b), a.approx || b.approx);
}

static Value divValues(const Value& a, const Value& b) {
    if (a.isInt && b.isInt) {
        if (b.i == 0) throw CalcError("division by zero");
        if (a.i == i128Min() && b.i == -1)
            return makeFloat((long double)a.i / (long double)b.i, true);
        if (a.i % b.i == 0) return makeInt(a.i / b.i);
        return makeFloat((long double)a.i / (long double)b.i, a.approx || b.approx);
    }
    long double d = toFloat(b);
    if (d == 0) throw CalcError("division by zero");
    return makeFloat(toFloat(a) / d, a.approx || b.approx);
}

static Value modValues(const Value& a, const Value& b) {
    if (a.isInt && b.isInt) {
        if (b.i == 0) throw CalcError("modulo by zero");
        if (a.i == i128Min() && b.i == -1) return makeInt(0);
        return makeInt(a.i % b.i);
    }
    long double d = toFloat(b);
    if (d == 0) throw CalcError("modulo by zero");
    return makeFloat(fmodl(toFloat(a), d), a.approx || b.approx);
}

static Value powValues(const Value& a, const Value& b) {
    if (a.isInt && b.isInt && b.i >= 0) {
        __int128 result = 1, base = a.i, e = b.i;
        bool overflow = false;
        while (e > 0) {
            if (e & 1) {
                __int128 t;
                if (__builtin_mul_overflow(result, base, &t)) {
                    overflow = true;
                    break;
                }
                result = t;
            }
            e >>= 1;
            if (e > 0) {
                __int128 t;
                if (__builtin_mul_overflow(base, base, &t)) {
                    overflow = true;
                    break;
                }
                base = t;
            }
        }
        if (!overflow) return makeInt(result);
        return makeFloat(powl((long double)a.i, (long double)b.i), true);
    }
    return makeFloat(powl(toFloat(a), toFloat(b)), a.approx || b.approx);
}

static Value negValue(const Value& v) {
    if (v.isInt) {
        if (v.i == i128Min()) return makeFloat(-(long double)v.i, true);
        return makeInt(-v.i);
    }
    return makeFloat(-v.f, v.approx);
}

static bool lessValue(const Value& a, const Value& b) {
    if (a.isInt && b.isInt) return a.i < b.i;
    return toFloat(a) < toFloat(b);
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

static std::string i128ToString(__int128 v) {
    if (v == 0) return "0";
    bool neg = v < 0;
    unsigned __int128 u = neg ? (unsigned __int128)(-(v + 1)) + 1u : (unsigned __int128)v;
    char buf[48];
    int n = 0;
    while (u > 0) {
        buf[n++] = (char)('0' + (int)(u % 10));
        u /= 10;
    }
    std::string out;
    if (neg) out += '-';
    while (n > 0) out += buf[--n];
    return out;
}

static std::string formatFloat(long double v, int sig) {
    if (std::isnan(v)) return "nan";
    if (std::isinf(v)) return v < 0 ? "-inf" : "inf";
    if (v == 0) return "0";
    if (sig < 1) sig = 1;
    if (sig > 30) sig = 30;
    char buf[512];
    std::snprintf(buf, sizeof buf, "%.*Lg", sig, v);
    return std::string(buf);
}

// Exact integers are printed in full; `sig` is the number of significant digits
// used for floating point results.
static std::string formatValue(const Value& v, int sig) {
    if (v.isInt) return i128ToString(v.i);
    std::string out = formatFloat(v.f, sig);
    if (v.approx) out += " (approximate: integer overflow, computed as floating point)";
    return out;
}

// ---------------------------------------------------------------------------
// functions
// ---------------------------------------------------------------------------

static Value callFunction(const std::string& name, const std::vector<Value>& args) {
    auto arity1 = [&]() {
        if (args.size() != 1)
            throw CalcError(name + "() expects 1 argument, got " + std::to_string(args.size()));
    };
    auto unary = [&](long double (*fn)(long double)) {
        arity1();
        return makeFloat(fn(toFloat(args[0])), args[0].approx);
    };

    if (name == "sqrt") return unary(sqrtl);
    if (name == "ln") return unary(logl);
    if (name == "log10") return unary(log10l);
    if (name == "log2") return unary(log2l);
    if (name == "exp") return unary(expl);
    if (name == "sin") return unary(sinl);
    if (name == "cos") return unary(cosl);
    if (name == "tan") return unary(tanl);

    if (name == "floor") {
        arity1();
        if (args[0].isInt) return args[0];
        return makeFloat(floorl(args[0].f), args[0].approx);
    }
    if (name == "ceil") {
        arity1();
        if (args[0].isInt) return args[0];
        return makeFloat(ceill(args[0].f), args[0].approx);
    }
    if (name == "round") {
        arity1();
        if (args[0].isInt) return args[0];
        return makeFloat(roundl(args[0].f), args[0].approx);
    }
    if (name == "abs") {
        arity1();
        if (args[0].isInt) {
            if (args[0].i == i128Min()) return makeFloat(-(long double)args[0].i, true);
            return makeInt(args[0].i < 0 ? -args[0].i : args[0].i);
        }
        return makeFloat(fabsl(args[0].f), args[0].approx);
    }

    if (name == "min" || name == "max") {
        if (args.size() < 2)
            throw CalcError(name + "() expects at least 2 arguments, got " +
                            std::to_string(args.size()));
        Value best = args[0];
        for (size_t k = 1; k < args.size(); k++) {
            bool take = (name == "min") ? lessValue(args[k], best) : lessValue(best, args[k]);
            if (take) best = args[k];
        }
        return best;
    }

    throw CalcError("unknown function '" + name + "'");
}

// ---------------------------------------------------------------------------
// variables and statements
// ---------------------------------------------------------------------------

using VarEnv = std::unordered_map<std::string, Value>;

// The built-in constants and functions may not be shadowed by variables.
static bool isReservedName(const std::string& name) {
    static const char* const kReserved[] = {
        "pi", "e",      "sqrt",  "abs",   "ln",  "log10", "log2", "exp", "sin",
        "cos", "tan",   "floor", "ceil",  "round", "min", "max",
    };
    for (const char* n : kReserved)
        if (name == n) return true;
    return false;
}

struct StatementOutcome {
    bool isAssignment = false;
    std::string name;  // assignment target, empty for plain expressions
    Value value;
};

// ---------------------------------------------------------------------------
// recursive descent parser
// ---------------------------------------------------------------------------

class Parser {
public:
    Parser(const std::string& src, const VarEnv& env) : s(src), env(env) {}

    // expr
    Value parse() {
        skipWs();
        if (atEnd()) throw CalcError("empty expression");
        Value v = parseExpr();
        expectEnd();
        return v;
    }

    // identifier '=' expr | expr
    StatementOutcome parseStatement() {
        skipWs();
        if (!atEnd() && (std::isalpha((unsigned char)cur()) || cur() == '_')) {
            size_t save = p;
            size_t start = p;
            while (p < s.size() && isIdentChar(s[p])) p++;
            std::string name = s.substr(start, p - start);
            skipWs();
            if (cur() == '=') {
                p++;
                if (isReservedName(name))
                    throw CalcError("cannot assign to reserved name '" + name + "'");
                skipWs();
                if (atEnd()) throw CalcError("expected expression after '='");
                StatementOutcome out;
                out.isAssignment = true;
                out.name = name;
                out.value = parseExpr();
                expectEnd();
                return out;
            }
            p = save;  // not an assignment -- re-parse as a plain expression
        }
        StatementOutcome out;
        out.value = parseExpr();
        expectEnd();
        return out;
    }

private:
    const std::string& s;
    const VarEnv& env;
    size_t p = 0;

    void expectEnd() {
        skipWs();
        if (!atEnd())
            throw CalcError(posError(
                p, std::string("unexpected trailing input starting with '") + s[p] + "'"));
    }

    bool atEnd() const { return p >= s.size(); }
    char cur() const { return p < s.size() ? s[p] : '\0'; }

    void skipWs() {
        while (p < s.size() && std::isspace((unsigned char)s[p])) p++;
    }

    static bool isDigit(char c) { return std::isdigit((unsigned char)c) != 0; }
    static bool isIdentChar(char c) { return std::isalnum((unsigned char)c) != 0 || c == '_'; }

    // expr := term (('+' | '-') term)*
    Value parseExpr() {
        Value v = parseTerm();
        for (;;) {
            skipWs();
            char c = cur();
            if (c == '+') {
                p++;
                v = addValues(v, parseTerm());
            } else if (c == '-') {
                p++;
                v = subValues(v, parseTerm());
            } else {
                return v;
            }
        }
    }

    // term := unary (('*' | '/' | '%') unary)*
    Value parseTerm() {
        Value v = parseUnary();
        for (;;) {
            skipWs();
            char c = cur();
            if (c == '*') {
                p++;
                v = mulValues(v, parseUnary());
            } else if (c == '/') {
                p++;
                v = divValues(v, parseUnary());
            } else if (c == '%') {
                p++;
                v = modValues(v, parseUnary());
            } else {
                return v;
            }
        }
    }

    // unary := ('-' | '+') unary | power
    Value parseUnary() {
        skipWs();
        char c = cur();
        if (c == '-') {
            p++;
            return negValue(parseUnary());
        }
        if (c == '+') {
            p++;
            return parseUnary();
        }
        return parsePower();
    }

    // power := primary ('^' unary)?     -- right associative, binds tighter
    //                                     than unary minus: -2^2 == -4
    Value parsePower() {
        Value base = parsePrimary();
        skipWs();
        if (cur() == '^') {
            p++;
            Value exp = parseUnary();
            return powValues(base, exp);
        }
        return base;
    }

    Value parsePrimary() {
        skipWs();
        if (atEnd()) throw CalcError("unexpected end of expression");
        char c = cur();

        if (c == '(') {
            size_t open = p;
            p++;
            Value v = parseExpr();
            skipWs();
            if (cur() != ')')
                throw CalcError("missing ')' for '(' at position " + std::to_string(open + 1));
            p++;
            return v;
        }
        if (isDigit(c) || (c == '.' && p + 1 < s.size() && isDigit(s[p + 1]))) return parseNumber();
        if (std::isalpha((unsigned char)c) || c == '_') return parseIdentifier();

        throw CalcError(posError(p, std::string("unexpected character '") + c + "'"));
    }

    Value parseNumber() {
        size_t start = p;
        bool hasDot = false, hasExp = false;

        while (p < s.size() && (isDigit(s[p]) || s[p] == '_')) p++;
        if (cur() == '.') {
            hasDot = true;
            p++;
            while (p < s.size() && (isDigit(s[p]) || s[p] == '_')) p++;
        }
        if (cur() == 'e' || cur() == 'E') {
            size_t save = p;
            size_t q = p + 1;
            if (q < s.size() && (s[q] == '+' || s[q] == '-')) q++;
            if (q < s.size() && (isDigit(s[q]) || s[q] == '_')) {
                hasExp = true;
                p = q;
                while (p < s.size() && (isDigit(s[p]) || s[p] == '_')) p++;
            } else {
                p = save;  // not an exponent, e.g. the constant in "2*e"
            }
        }

        std::string token = s.substr(start, p - start);
        std::string clean;
        clean.reserve(token.size());
        for (size_t k = 0; k < token.size(); k++) {
            if (token[k] == '_') {
                bool ok = k > 0 && k + 1 < token.size() && isDigit(token[k - 1]) &&
                          isDigit(token[k + 1]);
                if (!ok)
                    throw CalcError(posError(start, "invalid number literal '" + token + "'"));
                continue;
            }
            clean += token[k];
        }

        if (!hasDot && !hasExp) {
            __int128 acc = 0;
            bool overflow = false;
            for (char ch : clean) {
                if (!isDigit(ch))
                    throw CalcError(posError(start, "invalid number literal '" + token + "'"));
                __int128 t;
                if (__builtin_mul_overflow(acc, (__int128)10, &t) ||
                    __builtin_add_overflow(t, (__int128)(ch - '0'), &t)) {
                    overflow = true;
                    break;
                }
                acc = t;
            }
            if (!overflow) return makeInt(acc);
            return makeFloat(strtold(clean.c_str(), nullptr), true);
        }

        char* end = nullptr;
        long double v = strtold(clean.c_str(), &end);
        if (!end || *end != '\0')
            throw CalcError(posError(start, "invalid number literal '" + token + "'"));
        return makeFloat(v, false);
    }

    Value parseIdentifier() {
        size_t start = p;
        while (p < s.size() && isIdentChar(s[p])) p++;
        std::string name = s.substr(start, p - start);

        size_t after = p;
        skipWs();
        if (cur() != '(') {
            p = after;
            if (name == "pi") return makeFloat(3.141592653589793238462643383279502884L);
            if (name == "e") return makeFloat(2.718281828459045235360287471352662498L);
            auto it = env.find(name);
            if (it != env.end()) return it->second;
            throw CalcError(posError(start, "unknown identifier '" + name + "'"));
        }

        p++;  // '('
        std::vector<Value> args;
        skipWs();
        if (cur() == ')') {
            p++;
        } else {
            for (;;) {
                args.push_back(parseExpr());
                skipWs();
                if (cur() == ',') {
                    p++;
                    continue;
                }
                if (cur() == ')') {
                    p++;
                    break;
                }
                throw CalcError(posError(p, "expected ',' or ')' in call to " + name + "()"));
            }
        }
        return callFunction(name, args);
    }
};

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

static StatementOutcome runStatement(const std::string& text, VarEnv& env) {
    Parser parser(text, env);
    StatementOutcome out = parser.parseStatement();
    if (out.isAssignment) env[out.name] = out.value;
    return out;
}

static std::string trim(const std::string& in) {
    size_t b = 0, e = in.size();
    while (b < e && std::isspace((unsigned char)in[b])) b++;
    while (e > b && std::isspace((unsigned char)in[e - 1])) e--;
    return in.substr(b, e - b);
}

// Split on ';' and newlines; whitespace-only pieces are dropped.
static std::vector<std::string> splitStatements(const std::string& src) {
    std::vector<std::string> out;
    size_t start = 0;
    for (size_t k = 0; k <= src.size(); k++) {
        if (k < src.size() && src[k] != ';' && src[k] != '\n') continue;
        std::string piece = trim(src.substr(start, k - start));
        if (!piece.empty()) out.push_back(piece);
        start = k + 1;
    }
    return out;
}

static std::string evaluateToString(const std::string& expr, int sig) {
    static const VarEnv kNoVariables;
    Parser parser(expr, kNoVariables);
    return formatValue(parser.parse(), sig);
}

// ---------------------------------------------------------------------------
// minimal JSON (parser + serializer, no external libraries)
// ---------------------------------------------------------------------------

struct Json {
    enum Type { Null, Bool, Num, Str, Arr, Obj };
    Type type = Null;
    bool boolean = false;
    std::string str;  // Str: decoded text, Num: raw literal (echoed verbatim)
    std::vector<Json> arr;
    std::vector<std::pair<std::string, Json>> obj;

    const Json* find(const std::string& key) const {
        if (type != Obj) return nullptr;
        for (const auto& kv : obj)
            if (kv.first == key) return &kv.second;
        return nullptr;
    }
};

static Json jStr(const std::string& v) {
    Json j;
    j.type = Json::Str;
    j.str = v;
    return j;
}
static Json jRawNum(const std::string& raw) {
    Json j;
    j.type = Json::Num;
    j.str = raw;
    return j;
}
static Json jObj() {
    Json j;
    j.type = Json::Obj;
    return j;
}
static Json jArr() {
    Json j;
    j.type = Json::Arr;
    return j;
}
static Json jBool(bool b) {
    Json j;
    j.type = Json::Bool;
    j.boolean = b;
    return j;
}
static void jPut(Json& obj, const std::string& key, Json value) {
    obj.obj.emplace_back(key, std::move(value));
}

class JsonParser {
public:
    explicit JsonParser(const std::string& text) : s(text) {}

    bool parse(Json& out) {
        skipWs();
        if (!parseValue(out, 0)) return false;
        skipWs();
        if (p != s.size()) return fail("trailing data after JSON value");
        return true;
    }

    const std::string& error() const { return err; }

private:
    const std::string& s;
    size_t p = 0;
    std::string err;

    bool fail(const std::string& msg) {
        if (err.empty()) err = msg;
        return false;
    }

    void skipWs() {
        while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == '\n' || s[p] == '\r')) p++;
    }

    bool parseValue(Json& out, int depth) {
        if (depth > 64) return fail("nesting too deep");
        skipWs();
        if (p >= s.size()) return fail("unexpected end of input");
        char c = s[p];
        if (c == '{') return parseObject(out, depth);
        if (c == '[') return parseArray(out, depth);
        if (c == '"') {
            out.type = Json::Str;
            return parseString(out.str);
        }
        if (c == 't') return parseLiteral("true", out, true);
        if (c == 'f') return parseLiteral("false", out, false);
        if (c == 'n') return parseNull(out);
        return parseNumber(out);
    }

    bool parseLiteral(const char* lit, Json& out, bool value) {
        size_t len = std::strlen(lit);
        if (s.compare(p, len, lit) != 0) return fail("invalid literal");
        p += len;
        if (p < s.size() && !isDelim(s[p])) return fail("invalid literal");
        out.type = Json::Bool;
        out.boolean = value;
        return true;
    }

    bool parseNull(Json& out) {
        if (s.compare(p, 4, "null") != 0) return fail("invalid literal");
        p += 4;
        if (p < s.size() && !isDelim(s[p])) return fail("invalid literal");
        out.type = Json::Null;
        return true;
    }

    static bool isDelim(char c) {
        return c == ',' || c == '}' || c == ']' || c == ' ' || c == '\t' || c == '\n' ||
               c == '\r';
    }

    bool parseObject(Json& out, int depth) {
        out.type = Json::Obj;
        p++;  // '{'
        skipWs();
        if (p < s.size() && s[p] == '}') {
            p++;
            return true;
        }
        for (;;) {
            skipWs();
            if (p >= s.size() || s[p] != '"') return fail("expected object key");
            std::string key;
            if (!parseString(key)) return false;
            skipWs();
            if (p >= s.size() || s[p] != ':') return fail("expected ':'");
            p++;
            Json value;
            if (!parseValue(value, depth + 1)) return false;
            out.obj.emplace_back(std::move(key), std::move(value));
            skipWs();
            if (p < s.size() && s[p] == ',') {
                p++;
                continue;
            }
            if (p < s.size() && s[p] == '}') {
                p++;
                return true;
            }
            return fail("expected ',' or '}'");
        }
    }

    bool parseArray(Json& out, int depth) {
        out.type = Json::Arr;
        p++;  // '['
        skipWs();
        if (p < s.size() && s[p] == ']') {
            p++;
            return true;
        }
        for (;;) {
            Json value;
            if (!parseValue(value, depth + 1)) return false;
            out.arr.push_back(std::move(value));
            skipWs();
            if (p < s.size() && s[p] == ',') {
                p++;
                continue;
            }
            if (p < s.size() && s[p] == ']') {
                p++;
                return true;
            }
            return fail("expected ',' or ']'");
        }
    }

    bool parseString(std::string& out) {
        p++;  // '"'
        out.clear();
        for (;;) {
            if (p >= s.size()) return fail("unterminated string");
            unsigned char c = (unsigned char)s[p++];
            if (c == '"') return true;
            if (c < 0x20) return fail("control character in string");
            if (c != '\\') {
                out += (char)c;
                continue;
            }
            if (p >= s.size()) return fail("unterminated escape");
            char e = s[p++];
            switch (e) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    unsigned cp;
                    if (!parseHex4(cp)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF) {
                        if (p + 1 < s.size() && s[p] == '\\' && s[p + 1] == 'u') {
                            p += 2;
                            unsigned lo;
                            if (!parseHex4(lo)) return false;
                            if (lo >= 0xDC00 && lo <= 0xDFFF)
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            else
                                return fail("invalid surrogate pair");
                        } else {
                            return fail("unpaired surrogate");
                        }
                    }
                    appendUtf8(out, cp);
                    break;
                }
                default: return fail("invalid escape");
            }
        }
    }

    bool parseHex4(unsigned& out) {
        if (p + 4 > s.size()) return fail("truncated \\u escape");
        unsigned v = 0;
        for (int k = 0; k < 4; k++) {
            char c = s[p++];
            v <<= 4;
            if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
            else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
            else return fail("invalid \\u escape");
        }
        out = v;
        return true;
    }

    static void appendUtf8(std::string& out, unsigned cp) {
        if (cp < 0x80) {
            out += (char)cp;
        } else if (cp < 0x800) {
            out += (char)(0xC0 | (cp >> 6));
            out += (char)(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += (char)(0xE0 | (cp >> 12));
            out += (char)(0x80 | ((cp >> 6) & 0x3F));
            out += (char)(0x80 | (cp & 0x3F));
        } else {
            out += (char)(0xF0 | (cp >> 18));
            out += (char)(0x80 | ((cp >> 12) & 0x3F));
            out += (char)(0x80 | ((cp >> 6) & 0x3F));
            out += (char)(0x80 | (cp & 0x3F));
        }
    }

    bool parseNumber(Json& out) {
        size_t start = p;
        if (p < s.size() && s[p] == '-') p++;
        if (p >= s.size() || !std::isdigit((unsigned char)s[p])) return fail("invalid number");
        while (p < s.size() && std::isdigit((unsigned char)s[p])) p++;
        if (p < s.size() && s[p] == '.') {
            p++;
            if (p >= s.size() || !std::isdigit((unsigned char)s[p])) return fail("invalid number");
            while (p < s.size() && std::isdigit((unsigned char)s[p])) p++;
        }
        if (p < s.size() && (s[p] == 'e' || s[p] == 'E')) {
            size_t save = p;
            p++;
            if (p < s.size() && (s[p] == '+' || s[p] == '-')) p++;
            if (p < s.size() && std::isdigit((unsigned char)s[p])) {
                while (p < s.size() && std::isdigit((unsigned char)s[p])) p++;
            } else {
                p = save;
            }
        }
        out.type = Json::Num;
        out.str = s.substr(start, p - start);
        return true;
    }
};

static void jsonWriteString(const std::string& in, std::string& out) {
    out += '"';
    for (unsigned char c : in) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out += (char)c;  // UTF-8 passes through unchanged
                }
        }
    }
    out += '"';
}

static void jsonWrite(const Json& v, std::string& out) {
    switch (v.type) {
        case Json::Null: out += "null"; break;
        case Json::Bool: out += v.boolean ? "true" : "false"; break;
        case Json::Num: out += v.str; break;  // raw literal, echoed verbatim
        case Json::Str: jsonWriteString(v.str, out); break;
        case Json::Arr:
            out += '[';
            for (size_t k = 0; k < v.arr.size(); k++) {
                if (k) out += ',';
                jsonWrite(v.arr[k], out);
            }
            out += ']';
            break;
        case Json::Obj:
            out += '{';
            for (size_t k = 0; k < v.obj.size(); k++) {
                if (k) out += ',';
                jsonWriteString(v.obj[k].first, out);
                out += ':';
                jsonWrite(v.obj[k].second, out);
            }
            out += '}';
            break;
    }
}

static std::string jsonDump(const Json& v) {
    std::string out;
    jsonWrite(v, out);
    return out;
}

// ---------------------------------------------------------------------------
// MCP server (JSON-RPC 2.0 over stdio, one JSON message per line)
// ---------------------------------------------------------------------------

static const char* kDefaultProtocolVersion = "2024-11-05";
static const char* kServerVersion = "1.0.0";
static const char* kToolDescription =
    "Evaluate a mathematical expression and return the result. Supports numbers "
    "(1, 1.5, 1e3, 1_000), + - * / % ^ (right associative), unary minus, parentheses, "
    "the constants pi and e, and the functions sqrt, abs, ln, log10, log2, exp, sin, "
    "cos, tan, floor, ceil, round, min, max. Integer-only expressions are evaluated "
    "exactly with 128-bit integers; if an integer operation overflows, the result "
    "falls back to floating point and is marked approximate.";

static void emitJson(const std::string& line) {
    std::cout << line << '\n';
    std::cout.flush();
}

static std::string rpcResult(const Json& id, const Json& result) {
    Json msg = jObj();
    jPut(msg, "jsonrpc", jStr("2.0"));
    jPut(msg, "id", id);
    jPut(msg, "result", result);
    return jsonDump(msg);
}

static std::string rpcError(const Json& id, int code, const std::string& message) {
    Json err = jObj();
    jPut(err, "code", jRawNum(std::to_string(code)));
    jPut(err, "message", jStr(message));
    Json msg = jObj();
    jPut(msg, "jsonrpc", jStr("2.0"));
    jPut(msg, "id", id);
    jPut(msg, "error", std::move(err));
    return jsonDump(msg);
}

static Json toolResult(const std::string& text, bool isError) {
    Json item = jObj();
    jPut(item, "type", jStr("text"));
    jPut(item, "text", jStr(text));
    Json content = jArr();
    content.arr.push_back(std::move(item));
    Json result = jObj();
    jPut(result, "content", std::move(content));
    if (isError) jPut(result, "isError", jBool(true));
    return result;
}

static Json initializeResult(const Json& params) {
    std::string protocol = kDefaultProtocolVersion;
    if (const Json* pv = params.find("protocolVersion"))
        if (pv->type == Json::Str && !pv->str.empty()) protocol = pv->str;

    Json tools = jObj();
    Json capabilities = jObj();
    jPut(capabilities, "tools", std::move(tools));

    Json serverInfo = jObj();
    jPut(serverInfo, "name", jStr("ntg-calc"));
    jPut(serverInfo, "version", jStr(kServerVersion));

    Json result = jObj();
    jPut(result, "protocolVersion", jStr(protocol));
    jPut(result, "capabilities", std::move(capabilities));
    jPut(result, "serverInfo", std::move(serverInfo));
    jPut(result, "instructions",
         jStr("Arithmetic evaluator. Call the `calc` tool with an expression; use the optional "
              "`precision` argument (0-30 significant digits, default 12) for floating point "
              "results."));
    return result;
}

static Json toolsListResult() {
    Json expr = jObj();
    jPut(expr, "type", jStr("string"));
    jPut(expr, "description", jStr("Expression to evaluate, e.g. \"2^100\" or \"sqrt(2)*3\"."));

    Json precision = jObj();
    jPut(precision, "type", jStr("integer"));
    jPut(precision, "description",
         jStr("Significant digits used for non-integer results (default 12). Exact integer "
              "results are always printed in full."));
    jPut(precision, "minimum", jRawNum("0"));
    jPut(precision, "maximum", jRawNum("30"));
    jPut(precision, "default", jRawNum("12"));

    Json properties = jObj();
    jPut(properties, "expression", std::move(expr));
    jPut(properties, "precision", std::move(precision));

    Json required = jArr();
    required.arr.push_back(jStr("expression"));

    Json schema = jObj();
    jPut(schema, "type", jStr("object"));
    jPut(schema, "properties", std::move(properties));
    jPut(schema, "required", std::move(required));
    jPut(schema, "additionalProperties", jBool(false));

    Json tool = jObj();
    jPut(tool, "name", jStr("calc"));
    jPut(tool, "description", jStr(kToolDescription));
    jPut(tool, "inputSchema", std::move(schema));

    Json tools = jArr();
    tools.arr.push_back(std::move(tool));

    Json result = jObj();
    jPut(result, "tools", std::move(tools));
    return result;
}

// Returns true when the request produced an in-band tool result (written to
// `out`); returns false when the call was structurally invalid and a JSON-RPC
// error was written to `out` instead.
static bool handleToolCall(const Json& request, std::string& out) {
    const Json* params = request.find("params");
    const Json* name = params ? params->find("name") : nullptr;
    if (!name || name->type != Json::Str) {
        out = rpcError(*request.find("id"), -32602, "Invalid params: missing tool name");
        return false;
    }
    if (name->str != "calc") {
        out = rpcError(*request.find("id"), -32602, "Unknown tool: " + name->str);
        return false;
    }

    const Json* args = params->find("arguments");
    const Json* expr = args ? args->find("expression") : nullptr;
    if (!expr || expr->type != Json::Str || expr->str.empty()) {
        out = rpcResult(*request.find("id"),
                        toolResult("error: missing required string argument 'expression'", true));
        return false;
    }

    int precision = 12;
    if (const Json* pv = args->find("precision")) {
        bool ok = pv->type == Json::Num;
        double raw = 0;
        if (ok) {
            char* end = nullptr;
            raw = std::strtod(pv->str.c_str(), &end);
            ok = end && *end == '\0' && !std::isnan(raw) && raw == (double)(long)raw &&
                 raw >= 0.0 && raw <= 30.0;
        }
        if (!ok) {
            out = rpcResult(*request.find("id"),
                            toolResult("error: precision must be an integer between 0 and 30", true));
            return false;
        }
        precision = (int)raw;
    }

    try {
        out = rpcResult(*request.find("id"), toolResult(evaluateToString(expr->str, precision), false));
    } catch (const CalcError& e) {
        out = rpcResult(*request.find("id"), toolResult(std::string("error: ") + e.what(), true));
    }
    return true;
}

static int runMcpServer() {
    std::string line;
    while (std::getline(std::cin, line)) {
        bool blank = true;
        for (char c : line)
            if (!std::isspace((unsigned char)c)) {
                blank = false;
                break;
            }
        if (blank) continue;

        Json request;
        JsonParser parser(line);
        if (!parser.parse(request) || request.type != Json::Obj) {
            Json nullId;
            emitJson(rpcError(nullId, -32700, "Parse error"));
            continue;
        }

        const Json* id = request.find("id");
        bool hasId = id && id->type != Json::Null;
        const Json* method = request.find("method");
        if (!method || method->type != Json::Str) {
            if (hasId) emitJson(rpcError(*id, -32600, "Invalid Request: missing method"));
            continue;
        }

        if (method->str == "initialize") {
            const Json* params = request.find("params");
            Json empty = jObj();
            emitJson(rpcResult(*id, initializeResult(params ? *params : empty)));
        } else if (method->str == "notifications/initialized") {
            // notification: no response
        } else if (method->str == "tools/list") {
            emitJson(rpcResult(*id, toolsListResult()));
        } else if (method->str == "tools/call") {
            std::string out;
            handleToolCall(request, out);
            emitJson(out);
        } else if (hasId) {
            emitJson(rpcError(*id, -32601, "Method not found: " + method->str));
        }
        // notifications for unknown methods: ignored, no response
    }
    return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

static void printUsage(std::ostream& os) {
    os << "usage: ntg-calc <statement> [<statement> ...]\n"
          "       ntg-calc --mcp\n"
          "Every argument is one or more statements separated by ';' or newlines.\n"
          "Each statement prints 'expr = value'; 'name = expr' assigns a variable for later statements.\n"
          "The final value is echoed on the last line as '=> value'; a single expression prints just the value.\n"
          "Example: ntg-calc 'in = 3742118*1.40/1e6; out = 918447*4.40/1e6; in+out'\n";
}

static int runCli(const std::vector<std::string>& args) {
    const int sig = 12;

    std::string src;
    for (size_t k = 0; k < args.size(); k++) {
        if (k) src += '\n';
        src += args[k];
    }

    std::vector<std::string> stmts = splitStatements(src);
    if (stmts.empty()) {
        std::cerr << "error: empty expression\n";
        return 1;
    }

    VarEnv env;
    std::vector<std::string> lines;
    std::string finalValue;
    bool lastIsAssignment = false;
    size_t k = 0;
    try {
        for (; k < stmts.size(); k++) {
            StatementOutcome out = runStatement(stmts[k], env);
            lastIsAssignment = out.isAssignment;
            std::string value = formatValue(out.value, sig);
            lines.push_back((out.isAssignment ? out.name : stmts[k]) + " = " + value);
            finalValue = value;
        }
    } catch (const CalcError& e) {
        // Nothing has been printed yet: report the failure, drop the partial run.
        std::cerr << "error in statement " << (k + 1) << ": " << e.what() << '\n';
        return 1;
    }

    if (stmts.size() == 1 && !lastIsAssignment) {
        std::cout << finalValue << '\n';  // single expression: bare value
    } else {
        for (const std::string& line : lines) std::cout << line << '\n';
        std::cout << "=> " << finalValue << '\n';
    }
    return 0;
}

int main(int argc, char** argv) {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);

    if (argc >= 2) {
        std::string arg = argv[1];
        if (arg == "--mcp") return runMcpServer();
        if (arg == "-h" || arg == "--help") {
            printUsage(std::cout);
            return 0;
        }
    }
    if (argc < 2) {
        printUsage(std::cerr);
        return 2;
    }

    std::vector<std::string> args;
    for (int k = 1; k < argc; k++) {
        std::string arg = argv[k];
        // "--word" is an option, "--5" is just a doubly negated expression
        if (arg.size() > 2 && arg[0] == '-' && arg[1] == '-' &&
            std::isalpha((unsigned char)arg[2])) {
            std::cerr << "error: unknown option '" << arg << "'\n";
            printUsage(std::cerr);
            return 2;
        }
        args.push_back(arg);
    }
    return runCli(args);
}
