!define FABER_WORKER_HELPER_DIR "${__FILEDIR__}\..\desktop"
Var faberCheckpointMessage
Var faberCheckpointExit

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Never force-kill a worker before replacing files. The bundled helper checkpoints
; each owned profile, or asks an older release to be quit normally.
!macro customCheckAppRunning
  StrCpy $R4 "uninstall"
  !ifdef BUILD_UNINSTALLER
    ; --updated alone is not a checkpoint. Only a successful incoming prepare
    ; creates this process-local handoff, scoped to the exact installation root.
    ${If} ${isUpdated}
      ReadEnvStr $R3 "FABER_WORKER_PREPARE_HANDOFF"
      ${If} $R3 != ""
        ClearErrors
        FileOpen $R2 "$R3" r
        ${IfNot} ${Errors}
          FileRead $R2 $R1
          FileRead $R2 $R0
          FileClose $R2
          ${If} $R1 == "$INSTDIR"
          ${AndIf} $R0 == ""
            StrCpy $R4 "handoff"
            DetailPrint "Rechecking the incoming installer's checkpoint and profile ownership."
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !else
    ; Do not let a stale inherited marker stand in for this installer prepare.
    System::Call 'kernel32::SetEnvironmentVariableW(w "FABER_WORKER_PREPARE_HANDOFF", w "")'
  !endif
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    InitPluginsDir
    !ifdef BUILD_UNINSTALLER
      StrCpy $R6 "$INSTDIR\resources\app.asar\desktop\worker-update-cli.cjs"
      StrCpy $R5 $R4
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
    StrCpy $faberCheckpointExit $R0
    ${If} $R0 != 0
      ; Never display raw helper stderr: filesystem errors may contain local
      ; paths. These stable exit classes have fixed, non-secret explanations.
      ${If} $R0 == "20"
        StrCpy $faberCheckpointMessage "A profile has an invalid worker journal. Review or restore that profile before retrying."
      ${ElseIf} $R0 == "21"
        StrCpy $faberCheckpointMessage "A worker checkpoint needs recovery review because its evidence or current state differs. Reopen the prior Faber version to review recovery before retrying."
      ${ElseIf} $R0 == "22"
        StrCpy $faberCheckpointMessage "A running Faber worker did not finish its handoff. Quit Faber normally, wait for its worker to stop, then retry."
      ${ElseIf} $R0 == "error"
        StrCpy $faberCheckpointMessage "Windows could not start the installed Faber checkpoint helper. Check application access or repair the installed program files, then retry."
      ${ElseIf} $R0 == "timeout"
        StrCpy $faberCheckpointMessage "The Faber checkpoint helper timed out. Allow its worker to finish or quit Faber normally before retrying."
      ${Else}
        StrCpy $faberCheckpointMessage "The Faber checkpoint helper could not complete. Check access to the installed program and profile folders, then retry."
      ${EndIf}
      DetailPrint "$faberCheckpointMessage (checkpoint status: $R0)"
      MessageBox MB_OK|MB_ICONEXCLAMATION "$faberCheckpointMessage$\r$\n$\r$\nInstallation stopped. Profiles, receipts, credentials and model files were preserved." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    !ifndef BUILD_UNINSTALLER
      ; Stock electron-builder starts the prior uninstaller as a child. New
      ; uninstallers can consume this ephemeral receipt; published older ones
      ; still run their own hook and are reconciled by worker-update.cjs.
      ClearErrors
      FileOpen $R2 "$PLUGINSDIR\faber-worker-update\prepared-root.txt" w
      ${IfNot} ${Errors}
        FileWrite $R2 "$INSTDIR"
        FileClose $R2
        ${IfNot} ${Errors}
          System::Call 'kernel32::SetEnvironmentVariableW(w "FABER_WORKER_PREPARE_HANDOFF", w "$PLUGINSDIR\faber-worker-update\prepared-root.txt")'
        ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
!macroend

; Application data, add-ons, models and editable workbenches live outside $INSTDIR.
; The default upgrade/uninstall flow replaces program files only.
