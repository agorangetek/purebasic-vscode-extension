; PureBasic demo file for the language extension.
;
; Things to try:
;   1. Type "mess"           -> MessageRequester is proposed with a call snippet
;   2. Type "endproc"        -> EndProcedure is offered in the manual's casing
;   3. Hover over ReDim      -> the manual signature and the library it belongs to
;   4. Type "pt\"            -> the members of the Point structure
;   5. Type "count."         -> the built-in type suffixes (.i, .d, .s, ...)
;   6. Ctrl+Shift+O          -> outline of this file

EnableExplicit

; A point in 2D space.
Structure Point
	x.d
	y.d
EndStructure

#MaxPoints = 100

; Declares the buffer once, then fills it.
Procedure Fill(*p.Point, count.i)
	Protected i.i
	For i = 0 To count - 1
		*p\x = i
		*p\y = i * 2
		*p + SizeOf(Point)
	Next
EndProcedure

Procedure.d Distance(*a.Point, *b.Point)
	Protected dx.d = *a\x - *b\x
	Protected dy.d = *a\y - *b\y
	ProcedureReturn Sqr(dx * dx + dy * dy)
EndProcedure

If OpenWindow(0, 0, 0, 320, 200, "PureBasic", #PB_Window_SystemMenu)
	MessageRequester("PureBasic", "Hello from the demo")
	Repeat
		Event = WaitWindowEvent()
	Until Event = #PB_Event_CloseWindow
EndIf
