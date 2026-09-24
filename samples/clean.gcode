; Relative extrusion with proper retract/deretract around every travel.
; Audits clean at --threshold 1500 (1.5 units).
G90
M83
G1 Z0.2
G1 X10 Y10 E2.5   ; print move: XY displacement with net extrusion
G1 E-1.5          ; retract -> balance 1.500
G1 X50 Y50        ; travel, protected (balance 1.500 >= threshold)
G1 E1.5           ; deretract -> balance 0
G1 X60 Y50 E2.0   ; print move
G1 E-1.5          ; retract
G1 X10 Y10        ; travel, protected
G1 E1.5           ; deretract
G1 X10 Y30 E1.2   ; print move
