package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	emailVerifier "github.com/AfterShip/email-verifier"
	"github.com/julienschmidt/httprouter"
	"github.com/truemail-rb/truemail-go"
)

var miscVerifier = emailVerifier.NewVerifier()

type mxRecord struct {
	Host     string `json:"host"`
	Priority uint16 `json:"priority"`
}

type checkItem struct {
	Step    string `json:"step"`
	Passed  bool   `json:"passed"`
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
}

type miscInfo struct {
	Disposable  bool `json:"disposable"`
	RoleAccount bool `json:"role_account"`
	Free        bool `json:"free_provider"`
}

type verifyResponse struct {
	Email           string      `json:"email"`
	DomainValid     bool        `json:"domain_valid"`
	MailboxVerified string      `json:"mailbox_verified"`
	Valid           bool        `json:"valid"`
	Checks          []checkItem `json:"checks"`
	MxRecords       []mxRecord  `json:"mx_records"`
	Misc            miscInfo    `json:"misc"`
	SmtpHost        string      `json:"smtp_host,omitempty"`
	SmtpResponse    string      `json:"smtp_response,omitempty"`
	VerdictSummary  string      `json:"verdict_summary"`
	SyntaxValid     bool        `json:"syntax_valid"`
	SmtpCheckRan    bool        `json:"smtp_check_ran"`
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func buildConfiguration() (*truemail.Configuration, error) {
	port := 25
	if p := os.Getenv("SMTP_PORT"); p != "" {
		var parsed int
		if _, err := fmt.Sscanf(p, "%d", &parsed); err == nil && parsed > 0 {
			port = parsed
		}
	}
	return truemail.NewConfiguration(truemail.ConfigurationAttr{
		VerifierEmail:         "verifier@example.com",
		ValidationTypeDefault: "smtp",
		ConnectionTimeout:     5,
		ResponseTimeout:       10,
		ConnectionAttempts:    2,
		SmtpPort:              port,
		SmtpFailFast:          true,
		// Must stay false: truemail treats "SMTP could not run and it was not a
		// 550" as success when this is true, which marks every unverifiable
		// address as valid. Verified in lib/truemail-go/smtp.go.
		SmtpSafeCheck: false,
	})
}

func lookupMX(domain string) []mxRecord {
	mx, err := net.LookupMX(domain)
	if err != nil || len(mx) == 0 {
		return nil
	}
	sort.Slice(mx, func(i, j int) bool { return mx[i].Pref < mx[j].Pref })
	out := make([]mxRecord, 0, len(mx))
	for _, r := range mx {
		out = append(out, mxRecord{Host: strings.TrimSuffix(r.Host, "."), Priority: r.Pref})
	}
	return out
}

func isConnectionError(msg string) bool {
	lower := strings.ToLower(msg)
	return strings.Contains(lower, "connection") ||
		strings.Contains(lower, "timeout") ||
		strings.Contains(lower, "dial") ||
		strings.Contains(lower, "refused") ||
		strings.Contains(lower, "network") ||
		strings.Contains(lower, "i/o")
}

// Policy/transport rejections say nothing about whether the mailbox exists:
// a blacklisted IP, missing forward-confirmed rDNS, greylisting or a 4xx reply
// only means the server would not talk to us. Treating those as "invalid"
// produces false negatives, so they map to no_smtp (unknown) instead.
var inconclusiveSmtpPatterns = []string{
	"spamhaus", "blacklist", "blocked", "reverse dns", "fcrdns", "ptr record",
	"greylist", "rate limit", "too many", "service unavailable", "try again",
	"temporar", "policy", "access denied", "not permitted", "authentication",
	"insufficient permission", "no permission",
}

var smtpTemp4xxPattern = regexp.MustCompile(`\b4[0-9]{2}\b`)

func isInconclusiveSmtpResponse(msg string) bool {
	if msg == "" {
		return false
	}
	lower := strings.ToLower(msg)
	if smtpTemp4xxPattern.MatchString(lower) || strings.Contains(lower, "5.7.") {
		return true
	}
	for _, pattern := range inconclusiveSmtpPatterns {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}

func extractSmtpErrors(result *truemail.ValidatorResult) (host, response string, rcptAttempted bool) {
	for _, req := range result.SmtpDebug {
		if req.Host != "" {
			host = req.Host
		}
		if req.Response == nil {
			continue
		}
		for _, e := range req.Response.Errors {
			if e == nil {
				continue
			}
			msg := e.Error()
			rcptAttempted = true
			if response == "" || !isConnectionError(msg) {
				response = msg
			}
		}
		if req.Response.Rcptto {
			rcptAttempted = true
		}
	}
	return host, response, rcptAttempted
}

func verifyEmailAddress(email string) (*verifyResponse, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	cfg, err := buildConfiguration()
	if err != nil {
		return nil, err
	}

	result, err := truemail.Validate(email, cfg, "smtp")
	if err != nil {
		return nil, err
	}

	domain := result.Domain
	if domain == "" {
		parts := strings.Split(email, "@")
		if len(parts) == 2 {
			domain = parts[1]
		}
	}

	mxRecords := lookupMX(domain)
	checks := []checkItem{}

	syntaxValid := true
	if regexErr, ok := result.Errors["regex"]; ok {
		syntaxValid = false
		checks = append(checks, checkItem{
			Step: "syntax", Passed: false,
			Message: "The Email Address Syntax is incorrect",
			Detail:  regexErr,
		})
	} else {
		checks = append(checks, checkItem{
			Step: "syntax", Passed: true,
			Message: "The Email Address Syntax is correct",
		})
	}

	misc := miscInfo{}
	if parsed := miscVerifier.ParseAddress(email); parsed.Valid {
		misc.Disposable = miscVerifier.IsDisposable(parsed.Domain)
		misc.RoleAccount = miscVerifier.IsRoleAccount(parsed.Username)
		misc.Free = miscVerifier.IsFreeDomain(parsed.Domain)
	}

	if misc.Disposable {
		checks = append(checks, checkItem{Step: "misc", Passed: false, Message: "Disposable / temporary email domain detected"})
	} else {
		checks = append(checks, checkItem{Step: "misc", Passed: true, Message: "Not a known disposable domain"})
	}
	if misc.RoleAccount {
		checks = append(checks, checkItem{Step: "misc", Passed: false, Message: "Role-based email account (admin, info, etc.)"})
	}
	if misc.Free {
		checks = append(checks, checkItem{Step: "misc", Passed: true, Message: "Known free email provider"})
	}

	domainValid := syntaxValid && len(mxRecords) > 0 && !misc.Disposable
	if len(mxRecords) == 0 {
		checks = append(checks, checkItem{Step: "mx", Passed: false, Message: "No MX records found for domain"})
	} else {
		for _, mx := range mxRecords {
			checks = append(checks, checkItem{
				Step:    "mx",
				Passed:  true,
				Message: fmt.Sprintf("MX record found: %s (Priority %d)", mx.Host, mx.Priority),
			})
		}
	}

	smtpHost, smtpResponse, rcptAttempted := extractSmtpErrors(result)
	smtpRan := len(result.SmtpDebug) > 0
	mailboxVerified := "no_smtp"

	// A mailbox is only "yes" when an SMTP dialog actually ran. truemail can
	// report Success without attempting SMTP at all, and trusting that marked
	// unverifiable addresses (Yahoo, blacklisted IPs) as valid.
	if result.Success && smtpRan {
		mailboxVerified = "yes"
		if smtpHost != "" {
			checks = append(checks, checkItem{
				Step: "smtp", Passed: true,
				Message: fmt.Sprintf("Dialog with %s succeeded", smtpHost),
				Detail:  "250 OK",
			})
		}
	} else if result.Success && !smtpRan {
		mailboxVerified = "no_smtp"
		checks = append(checks, checkItem{
			Step:    "smtp",
			Passed:  false,
			Message: "SMTP check did not run",
			Detail:  "Mailbox not confirmed — no SMTP dialog was attempted",
		})
	} else if smtpRan {
		for _, req := range result.SmtpDebug {
			host := req.Host
			if host == "" {
				continue
			}
			passed := req.Response != nil && req.Response.Rcptto
			detail := ""
			if req.Response != nil {
				for _, e := range req.Response.Errors {
					if e != nil {
						detail = e.Error()
					}
				}
			}
			if passed {
				checks = append(checks, checkItem{
					Step: "smtp", Passed: true,
					Message: fmt.Sprintf("Dialog with %s succeeded", host),
					Detail:  "250 OK",
				})
			} else {
				if detail == "" {
					detail = "Mailbox not confirmed"
				}
				checks = append(checks, checkItem{
					Step: "smtp", Passed: false,
					Message: fmt.Sprintf("Dialog with %s", host),
					Detail:  detail,
				})
			}
		}

		// Conclusive only when the server actually rejected the recipient for a
		// non-policy reason (550 5.1.1 / user unknown). Policy and transport
		// rejections stay "unknown" rather than being called invalid.
		if rcptAttempted && smtpResponse != "" && !isConnectionError(smtpResponse) && !isInconclusiveSmtpResponse(smtpResponse) {
			mailboxVerified = "no"
		}
	}

	valid := mailboxVerified == "yes"
	summary := email + " seems to be valid"
	if !valid {
		summary = email + " seems not to be valid"
	}
	if mailboxVerified == "no_smtp" && domainValid {
		summary = email + " — domain OK but mailbox could not be verified (SMTP blocked or unavailable)"
	}

	return &verifyResponse{
		Email:           email,
		DomainValid:     domainValid,
		MailboxVerified: mailboxVerified,
		Valid:           valid,
		Checks:          checks,
		MxRecords:       mxRecords,
		Misc:            misc,
		SmtpHost:        smtpHost,
		SmtpResponse:    smtpResponse,
		VerdictSummary:  summary,
		SyntaxValid:     syntaxValid,
		SmtpCheckRan:    smtpRan,
	}, nil
}

func healthHandler(w http.ResponseWriter, _ *http.Request, _ httprouter.Params) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":    "ok",
		"engine":    "truemail-go + AfterShip misc",
		"smtp_port": 25,
	})
}

func singleHandler(w http.ResponseWriter, _ *http.Request, ps httprouter.Params) {
	email := ps.ByName("email")
	if email == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "email is required"})
		return
	}
	resp, err := verifyEmailAddress(email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

type bulkRequest struct {
	Emails []string `json:"emails"`
}

func bulkHandler(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	var req bulkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	results := make([]interface{}, 0, len(req.Emails))
	for _, email := range req.Emails {
		resp, err := verifyEmailAddress(email)
		if err != nil {
			results = append(results, map[string]string{"email": email, "error": err.Error()})
			continue
		}
		results = append(results, resp)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"count": len(results), "results": results})
}

func main() {
	router := httprouter.New()
	router.GET("/health", healthHandler)
	router.GET("/v1/:email/verification", singleHandler)
	router.POST("/v1/bulk/verification", bulkHandler)

	server := &http.Server{
		Addr:         ":8080",
		Handler:      cors(router),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 180 * time.Second,
	}
	addr := ":8080"
	if p := os.Getenv("VERIFIER_GO_PORT"); p != "" {
		addr = ":" + strings.TrimPrefix(p, ":")
	}
	log.Printf("Email verifier API (truemail-go) listening on %s", addr)
	server.Addr = addr
	log.Fatal(server.ListenAndServe())
}
