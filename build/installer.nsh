!define FABER_WORKER_HELPER_DIR "${__FILEDIR__}\..\desktop"

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Never force-kill a worker before replacing files. The bundled helper checkpoints
; each owned profile, or asks an older release to be quit normally.
!macro customCheckAppRunning
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    InitPluginsDir
    !ifdef BUILD_UNINSTALLER
      StrCpy $R6 "$INSTDIR\resources\app.asar\desktop\worker-update-cli.cjs"
      StrCpy $R5 "uninstall"
    !else
      StrCpy $R9 $OUTDIR
      SetOutPath "$PLUGINSDIR\faber-worker-update"
      File /oname=worker-update-cli.cjs "${FABER_WORKER_HELPER_DIR}\worker-update-cli.cjs"
      File /oname=worker-update.cjs "${FABER_WORKER_HELPER_DIR}\worker-update.cjs"
      File /oname=worker-control.cjs "${FABER_WORKER_HELPER_DIR}\worker-control.cjs"
      File /oname=action-ledger.cjs "${FABER_WORKER_HELPER_DIR}\action-ledger.cjs"
      File /oname=profile-owner.cjs "${FABER_WORKER_HELPER_DIR}\profile-owner.cjs"
      File /oname=profile-path.cjs "${FABER_WORKER_HELPER_DIR}\profile-path.cjs"
      StrCpy $R6 "$PLUGINSDIR\faber-worker-update\worker-update-cli.cjs"
      StrCpy $R5 "prepare"
      SetOutPath $R9
    !endif
    ReadEnvStr $R7 "ELECTRON_RUN_AS_NODE"
    System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1")'
    nsExec::ExecToStack '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$R6" --mode "$R5" --install-root "$INSTDIR" --to-version "${VERSION}"'
    Pop $R0
    Pop $R1
    System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "$R7")'
    ${If} $R0 != 0
      DetailPrint $R1
      MessageBox MB_OK|MB_ICONEXCLAMATION "Faber could not finish its worker checkpoint. Quit Faber normally and retry. Profiles, receipts, credentials and model files were preserved."
      Abort
    ${EndIf}
  ${EndIf}
!macroend

; Application data, add-ons, models and editable workbenches live outside $INSTDIR.
; The default upgrade/uninstall flow replaces program files only.
