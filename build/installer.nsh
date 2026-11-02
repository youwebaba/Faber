!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Application data, add-ons, models and editable workbenches live outside $INSTDIR.
; The default upgrade/uninstall flow replaces program files only.
