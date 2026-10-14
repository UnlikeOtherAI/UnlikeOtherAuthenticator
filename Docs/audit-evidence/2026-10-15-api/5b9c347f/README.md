# Lifecycle gate — 5b9c347f

Serial Maxis/Fedora owned PostgreSQL run. Fourteen lifecycle cases pass.
The previous begin-deletion transaction failure is resolved with its original
15-second production budget. The scale case proceeds into staged cleanup but
hits its separate 60-second end-to-end test limit (61.534s). This is still a failed
gate, not acceptance. Other four lifecycle cases and selected refusal/source
files did not run. Full sanitized stdout retained; exit1.

Audit schema/job/progress/lease retained. No record or lease manually cleared.
Compiler/test child completed; slot released for a test-budget correction and
supported-service recovery of the retained job. Production transaction budget
remains15seconds.
