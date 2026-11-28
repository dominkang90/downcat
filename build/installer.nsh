; 설치 화면에 "바로가기를 어디에 만들까요" 쪽을 넣는다. electron-builder가 이 파일을 설치 틀에 끼워 넣는다.
; 조용한 설치(/S)와 업데이트 때는 이 쪽이 뜨지 않고, 그때는 아무것도 지우지 않는다.
!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var scAsked
  Var scDesktop
  Var scStartMenu
  Var scDesktopBox
  Var scStartMenuBox

  !macro customPageAfterChangeDir
    Page custom scPageCreate scPageLeave

    Function scPageCreate
      ${if} ${isUpdated}
        Abort
      ${endif}
      !insertmacro MUI_HEADER_TEXT "바로가기" "받냥이 바로가기를 만들 곳을 고르세요."
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateCheckbox} 0 10u 100% 12u "바탕 화면에 바로가기 만들기"
      Pop $scDesktopBox
      ${NSD_Check} $scDesktopBox
      ${NSD_CreateCheckbox} 0 30u 100% 12u "시작 메뉴에 넣기"
      Pop $scStartMenuBox
      ${NSD_Check} $scStartMenuBox
      nsDialogs::Show
    FunctionEnd

    Function scPageLeave
      ${NSD_GetState} $scDesktopBox $scDesktop
      ${NSD_GetState} $scStartMenuBox $scStartMenu
      StrCpy $scAsked "1"
    FunctionEnd
  !macroend

  ; 설치 틀이 바로가기를 둘 다 만든 뒤에 불린다. 체크를 뺀 것만 지운다.
  !macro customInstall
    ${if} $scAsked == "1"
      ${if} $scDesktop != ${BST_CHECKED}
        WinShell::UninstShortcut "$newDesktopLink"
        Delete "$newDesktopLink"
      ${endif}
      ${if} $scStartMenu != ${BST_CHECKED}
        WinShell::UninstShortcut "$newStartMenuLink"
        Delete "$newStartMenuLink"
        StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}" ; 끝 화면의 [실행]이 지운 바로가기를 찾지 않게
      ${endif}
    ${endif}
  !macroend
!endif
