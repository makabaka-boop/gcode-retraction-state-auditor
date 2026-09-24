; Absolute extrusion with a mid-print G92 E0 origin reset.
; The auditor tracks the reset, so `G1 E-1.5` is a 1.5 retraction
; (not a 9.5 jump from the old coordinate). Audits clean at --threshold 1500.
G90
M82
G1 X10 Y10 E5.0   ; print move
G1 X20 Y10 E8.0   ; print move
G92 E0            ; reset E origin; balance unchanged
G1 E-1.5          ; retract 1.5 -> balance 1.500
G1 X50 Y50        ; travel, protected
G1 E0             ; deretract 1.5 -> balance 0
G1 X60 Y50 E3.0   ; print move
