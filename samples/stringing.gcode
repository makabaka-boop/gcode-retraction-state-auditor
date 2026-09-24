; Retraction of 0.5 is below the 1.5 threshold, so the travel on line 8
; strings. Expected report at --threshold 1500:
;   UNPROTECTED_TRAVEL line=8 mode=G90/M83 X=40.000 Y=40.000 Z=0.200 E=-0.500 balance=0.500 threshold=1.500
G90
M83
G1 Z0.2
G1 E-0.5
G1 X40 Y40
