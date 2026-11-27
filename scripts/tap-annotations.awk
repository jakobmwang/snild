# Each failed test of a TAP report (node --test --test-reporter=tap) as a GitHub Actions annotation: the
# test's name and the first lines of its error, so a failed run says what failed without opening its log.
# Usage: awk -v label=Edge -f scripts/tap-annotations.awk report.tap
function escape(s) { gsub(/%/, "%25", s); gsub(/\r/, "%0D", s); gsub(/\n/, "%0A", s); return s }
function indent(s) { return match(s, /[^ ]/) ? RSTART - 1 : length(s) }
function emit() {
  if (name != "") printf "::error title=%s::%s\n", label, escape(text != "" ? name ": " text : name)
  name = ""; text = ""; grab = 0; lines = 0
}
# First, the lines of an error block (indented past its "error:"), whatever they say, even "not ok ...".
grab {
  if ($0 ~ /^ *$/) next
  if (indent($0) > at) { line = $0; sub(/^ +/, "", line); if (lines++ < 6) text = text (text == "" ? "" : " | ") line; next }
  grab = 0  # back at the level of error: the next field
}
/^ *not ok [0-9]+ - / { emit(); name = $0; sub(/^ *not ok [0-9]+ - /, "", name); next }
name != "" && /^ *error: / {
  at = indent($0); line = $0; sub(/^ *error: /, "", line)
  if (line ~ /^[|>][+-]?$/) { grab = 1; next }  # a block: the indented lines that follow
  gsub(/^'|'$/, "", line); text = line; next
}
name != "" && /^ *\.\.\.$/ { emit() }
END { emit() }
