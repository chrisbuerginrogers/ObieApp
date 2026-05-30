<?xml version='1.0' encoding='UTF-8'?>
<Project Type="Project" LVVersion="22308000">
	<Property Name="NI.LV.All.SaveVersion" Type="Str">22.3</Property>
	<Property Name="NI.LV.All.SourceOnly" Type="Bool">false</Property>
	<Property Name="NI.Project.Description" Type="Str"></Property>
	<Item Name="My Computer" Type="My Computer">
		<Property Name="NI.SortType" Type="Int">3</Property>
		<Property Name="server.app.propertiesEnabled" Type="Bool">true</Property>
		<Property Name="server.control.propertiesEnabled" Type="Bool">true</Property>
		<Property Name="server.tcp.enabled" Type="Bool">false</Property>
		<Property Name="server.tcp.port" Type="Int">0</Property>
		<Property Name="server.tcp.serviceName" Type="Str">My Computer/</Property>
		<Property Name="server.tcp.serviceName.default" Type="Str">My Computer/</Property>
		<Property Name="server.vi.callsEnabled" Type="Bool">true</Property>
		<Property Name="server.vi.propertiesEnabled" Type="Bool">true</Property>
		<Property Name="specify.custom.address" Type="Bool">false</Property>
		<Item Name="ViolinSubs" Type="Folder" URL="../ViolinSubs">
			<Property Name="NI.DISK" Type="Bool">true</Property>
		</Item>
		<Item Name="_ToDo.rtf" Type="Document" URL="../_ToDo.rtf"/>
		<Item Name="Curtin1.vi" Type="VI" URL="../Curtin1.vi"/>
		<Item Name="Curtin_DAQ.vi" Type="VI" URL="../Curtin_DAQ.vi"/>
		<Item Name="Icon.ico" Type="Document" URL="../Icon.ico"/>
		<Item Name="LiveSignal.vi" Type="VI" URL="../LiveSignal.vi"/>
		<Item Name="MassBandAnalysis.vi" Type="VI" URL="../MassBandAnalysis.vi"/>
		<Item Name="MicTest.vi" Type="VI" URL="../MicTest.vi"/>
		<Item Name="VerySimpleCalibCheck.vi" Type="VI" URL="../VerySimpleCalibCheck.vi"/>
		<Item Name="ZipUpCode.vi" Type="VI" URL="../ZipUpCode.vi"/>
		<Item Name="SavedSignal.vi" Type="VI" URL="../SavedSignal.vi"/>
		<Item Name="Dependencies" Type="Dependencies"/>
		<Item Name="Build Specifications" Type="Build">
			<Item Name="Oberlin Acoustics" Type="EXE">
				<Property Name="App_copyErrors" Type="Bool">true</Property>
				<Property Name="App_INI_aliasGUID" Type="Str">{D6B850A5-87F9-478C-9B33-DF3437AEE0E3}</Property>
				<Property Name="App_INI_GUID" Type="Str">{005D7E30-1833-42CF-A65C-06A2863DFA63}</Property>
				<Property Name="App_serverConfig.httpPort" Type="Int">8002</Property>
				<Property Name="App_serverType" Type="Int">1</Property>
				<Property Name="Bld_autoIncrement" Type="Bool">true</Property>
				<Property Name="Bld_buildCacheID" Type="Str">{96E4B4BA-2B31-42C0-8061-4947D3879408}</Property>
				<Property Name="Bld_buildSpecName" Type="Str">Oberlin Acoustics</Property>
				<Property Name="Bld_excludeInlineSubVIs" Type="Bool">true</Property>
				<Property Name="Bld_excludeLibraryItems" Type="Bool">true</Property>
				<Property Name="Bld_excludePolymorphicVIs" Type="Bool">true</Property>
				<Property Name="Bld_localDestDir" Type="Path">../builds/ObieApp</Property>
				<Property Name="Bld_localDestDirType" Type="Str">relativeToCommon</Property>
				<Property Name="Bld_modifyLibraryFile" Type="Bool">true</Property>
				<Property Name="Bld_postActionVIID" Type="Ref">/My Computer/ViolinSubs/Install Runtime Engine 2012 NIVerified.vi</Property>
				<Property Name="Bld_previewCacheID" Type="Str">{9921D856-B494-4A5F-85F3-D1F9D297A3F9}</Property>
				<Property Name="Bld_supportedLanguageCount" Type="Int">1</Property>
				<Property Name="Bld_supportedLanguage[0]" Type="Str">English</Property>
				<Property Name="Bld_version.build" Type="Int">151</Property>
				<Property Name="Bld_version.major" Type="Int">1</Property>
				<Property Name="DestinationCount" Type="Int">2</Property>
				<Property Name="Destination[0].destName" Type="Str">ObieApp.app</Property>
				<Property Name="Destination[0].path" Type="Path">../builds/ObieApp/ObieApp.app</Property>
				<Property Name="Destination[0].preserveHierarchy" Type="Bool">true</Property>
				<Property Name="Destination[0].type" Type="Str">App</Property>
				<Property Name="Destination[1].destName" Type="Str">Support Directory</Property>
				<Property Name="Destination[1].path" Type="Path">../builds/ObieApp/ObieApp.app/Contents/Resources</Property>
				<Property Name="SourceCount" Type="Int">2</Property>
				<Property Name="Source[0].itemID" Type="Str">{CB8ECE92-0A96-4164-B9E6-28E1CDCFD90A}</Property>
				<Property Name="Source[0].type" Type="Str">Container</Property>
				<Property Name="Source[1].destinationIndex" Type="Int">0</Property>
				<Property Name="Source[1].itemID" Type="Ref">/My Computer/Curtin1.vi</Property>
				<Property Name="Source[1].sourceInclusion" Type="Str">TopLevel</Property>
				<Property Name="Source[1].type" Type="Str">VI</Property>
				<Property Name="TgtF_fileDescription" Type="Str">Oberlin Acoustics</Property>
				<Property Name="TgtF_internalName" Type="Str">com.Rogerse.OberlinAcoustics</Property>
				<Property Name="TgtF_legalCopyright" Type="Str">Copyright 2018 </Property>
				<Property Name="TgtF_productName" Type="Str">Oberlin Acoustics</Property>
				<Property Name="TgtF_targetfileGUID" Type="Str">{BE542A28-E24F-458B-9D8A-329DB32A870C}</Property>
				<Property Name="TgtF_targetfileName" Type="Str">ObieApp.app</Property>
				<Property Name="TgtF_versionIndependent" Type="Bool">true</Property>
			</Item>
			<Item Name="ObieInstaller" Type="Installer">
				<Property Name="DestinationCount" Type="Int">1</Property>
				<Property Name="Destination[0].name" Type="Str">ObieApp</Property>
				<Property Name="Destination[0].parent" Type="Str">{3912416A-D2E5-411B-AFEE-B63654D690C0}</Property>
				<Property Name="Destination[0].tag" Type="Str">{05DEC322-9B94-4042-BFC3-F35B64D3F010}</Property>
				<Property Name="Destination[0].type" Type="Str">userFolder</Property>
				<Property Name="DistPartCount" Type="Int">3</Property>
				<Property Name="DistPart[0].flavorID" Type="Str">_deployment_</Property>
				<Property Name="DistPart[0].productID" Type="Str">{016644E7-BFD9-410F-902D-962614CB4E72}</Property>
				<Property Name="DistPart[0].productName" Type="Str">NI-VISA Runtime 22.5</Property>
				<Property Name="DistPart[0].upgradeCode" Type="Str">{8627993A-3F66-483C-A562-0D3BA3F267B1}</Property>
				<Property Name="DistPart[1].flavorID" Type="Str">DefaultFull</Property>
				<Property Name="DistPart[1].productID" Type="Str">{2BB15880-EA12-40AA-B577-27419E77E2F9}</Property>
				<Property Name="DistPart[1].productName" Type="Str">NI LabVIEW Runtime 2019 SP1 f5</Property>
				<Property Name="DistPart[1].SoftDepCount" Type="Int">12</Property>
				<Property Name="DistPart[1].SoftDep[0].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[1].SoftDep[0].productName" Type="Str">NI ActiveX Container</Property>
				<Property Name="DistPart[1].SoftDep[0].upgradeCode" Type="Str">{1038A887-23E1-4289-B0BD-0C4B83C6BA21}</Property>
				<Property Name="DistPart[1].SoftDep[10].exclude" Type="Bool">false</Property>
				<Property Name="DistPart[1].SoftDep[10].productName" Type="Str">NI LabVIEW Runtime 2019 SP1 Non-English Support.</Property>
				<Property Name="DistPart[1].SoftDep[10].upgradeCode" Type="Str">{446D49A5-F830-4ADF-8C78-F03284D6882D}</Property>
				<Property Name="DistPart[1].SoftDep[11].exclude" Type="Bool">false</Property>
				<Property Name="DistPart[1].SoftDep[11].productName" Type="Str">NI LabVIEW Web Server 2019</Property>
				<Property Name="DistPart[1].SoftDep[11].upgradeCode" Type="Str">{0960380B-EA86-4E0C-8B57-14CD8CCF2C15}</Property>
				<Property Name="DistPart[1].SoftDep[1].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[1].SoftDep[1].productName" Type="Str">NI Deployment Framework 2019</Property>
				<Property Name="DistPart[1].SoftDep[1].upgradeCode" Type="Str">{838942E4-B73C-492E-81A3-AA1E291FD0DC}</Property>
				<Property Name="DistPart[1].SoftDep[2].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[1].SoftDep[2].productName" Type="Str">NI LabVIEW Real-Time NBFifo 2019</Property>
				<Property Name="DistPart[1].SoftDep[2].upgradeCode" Type="Str">{8386B074-C90C-43A8-99F2-203BAAB4111C}</Property>
				<Property Name="DistPart[1].SoftDep[3].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[1].SoftDep[3].productName" Type="Str">NI Logos 19.0</Property>
				<Property Name="DistPart[1].SoftDep[3].upgradeCode" Type="Str">{5E4A4CE3-4D06-11D4-8B22-006008C16337}</Property>
				<Property Name="DistPart[1].SoftDep[4].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[1].SoftDep[4].productName" Type="Str">NI mDNS Responder 19.0</Property>
				<Property Name="DistPart[1].SoftDep[4].upgradeCode" Type="Str">{9607874B-4BB3-42CB-B450-A2F5EF60BA3B}</Property>
				<Property Name="DistPart[1].SoftDep[5].exclude" Type="Bool">false</Property>
				<Property Name="DistPart[1].SoftDep[5].productName" Type="Str">Math Kernel Libraries 2017</Property>
				<Property Name="DistPart[1].SoftDep[5].upgradeCode" Type="Str">{699C1AC5-2CF2-4745-9674-B19536EBA8A3}</Property>
				<Property Name="DistPart[1].SoftDep[6].exclude" Type="Bool">false</Property>
				<Property Name="DistPart[1].SoftDep[6].productName" Type="Str">Math Kernel Libraries 2018</Property>
				<Property Name="DistPart[1].SoftDep[6].upgradeCode" Type="Str">{33A780B9-8BDE-4A3A-9672-24778EFBEFC4}</Property>
				<Property Name="DistPart[1].SoftDep[7].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[1].SoftDep[7].productName" Type="Str">NI VC2015 Runtime</Property>
				<Property Name="DistPart[1].SoftDep[7].upgradeCode" Type="Str">{D42E7BAE-6589-4570-B6A3-3E28889392E7}</Property>
				<Property Name="DistPart[1].SoftDep[8].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[1].SoftDep[8].productName" Type="Str">NI TDM Streaming 19.0</Property>
				<Property Name="DistPart[1].SoftDep[8].upgradeCode" Type="Str">{4CD11BE6-6BB7-4082-8A27-C13771BC309B}</Property>
				<Property Name="DistPart[1].SoftDep[9].exclude" Type="Bool">false</Property>
				<Property Name="DistPart[1].SoftDep[9].productName" Type="Str">NI Error Reporting 2019</Property>
				<Property Name="DistPart[1].SoftDep[9].upgradeCode" Type="Str">{42E818C6-2B08-4DE7-BD91-B0FD704C119A}</Property>
				<Property Name="DistPart[1].upgradeCode" Type="Str">{7D6295E5-8FB8-4BCE-B1CD-B5B396FA1D3F}</Property>
				<Property Name="DistPart[2].flavorID" Type="Str">DefaultFull</Property>
				<Property Name="DistPart[2].productID" Type="Str">{A6603764-BA80-48E9-9E68-1C876DDDC916}</Property>
				<Property Name="DistPart[2].productName" Type="Str">NI LabVIEW Runtime 2022 Q3 Patch 1</Property>
				<Property Name="DistPart[2].SoftDepCount" Type="Int">12</Property>
				<Property Name="DistPart[2].SoftDep[0].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[2].SoftDep[0].productName" Type="Str">NI ActiveX Container</Property>
				<Property Name="DistPart[2].SoftDep[0].upgradeCode" Type="Str">{1038A887-23E1-4289-B0BD-0C4B83C6BA21}</Property>
				<Property Name="DistPart[2].SoftDep[10].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[2].SoftDep[10].productName" Type="Str">NI VC2015 Runtime</Property>
				<Property Name="DistPart[2].SoftDep[10].upgradeCode" Type="Str">{D42E7BAE-6589-4570-B6A3-3E28889392E7}</Property>
				<Property Name="DistPart[2].SoftDep[11].exclude" Type="Bool">false</Property>
				<Property Name="DistPart[2].SoftDep[11].productName" Type="Str">NI TDM Streaming 22.3</Property>
				<Property Name="DistPart[2].SoftDep[11].upgradeCode" Type="Str">{4CD11BE6-6BB7-4082-8A27-C13771BC309B}</Property>
				<Property Name="DistPart[2].SoftDep[1].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[2].SoftDep[1].productName" Type="Str">NI Deployment Framework 2022</Property>
				<Property Name="DistPart[2].SoftDep[1].upgradeCode" Type="Str">{838942E4-B73C-492E-81A3-AA1E291FD0DC}</Property>
				<Property Name="DistPart[2].SoftDep[2].exclude" Type="Bool">false</Property>
				<Property Name="DistPart[2].SoftDep[2].productName" Type="Str">NI Error Reporting 2020</Property>
				<Property Name="DistPart[2].SoftDep[2].upgradeCode" Type="Str">{42E818C6-2B08-4DE7-BD91-B0FD704C119A}</Property>
				<Property Name="DistPart[2].SoftDep[3].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[2].SoftDep[3].productName" Type="Str">NI LabVIEW Real-Time NBFifo 2022</Property>
				<Property Name="DistPart[2].SoftDep[3].upgradeCode" Type="Str">{662E78D2-A4FF-3910-B34B-AE7298505A08}</Property>
				<Property Name="DistPart[2].SoftDep[4].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[2].SoftDep[4].productName" Type="Str">NI LabVIEW Runtime 2022 Q3 Non-English Support.</Property>
				<Property Name="DistPart[2].SoftDep[4].upgradeCode" Type="Str">{CF1A7558-7F6E-3A4D-92E2-1DD8C05011C0}</Property>
				<Property Name="DistPart[2].SoftDep[5].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[2].SoftDep[5].productName" Type="Str">NI Logos 22.3</Property>
				<Property Name="DistPart[2].SoftDep[5].upgradeCode" Type="Str">{5E4A4CE3-4D06-11D4-8B22-006008C16337}</Property>
				<Property Name="DistPart[2].SoftDep[6].exclude" Type="Bool">true</Property>
				<Property Name="DistPart[2].SoftDep[6].productName" Type="Str">NI LabVIEW Web Server 2022</Property>
				<Property Name="DistPart[2].SoftDep[6].upgradeCode" Type="Str">{0960380B-EA86-4E0C-8B57-14CD8CCF2C15}</Property>
				<Property Name="DistPart[2].SoftDep[7].exclude" Type="Bool">false</Property>
				<Property Name="DistPart[2].SoftDep[7].productName" Type="Str">NI mDNS Responder 22.5</Property>
				<Property Name="DistPart[2].SoftDep[7].upgradeCode" Type="Str">{9607874B-4BB3-42CB-B450-A2F5EF60BA3B}</Property>
				<Property Name="DistPart[2].SoftDep[8].exclude" Type="Bool">false</Property>
				<Property Name="DistPart[2].SoftDep[8].productName" Type="Str">Math Kernel Libraries 2017</Property>
				<Property Name="DistPart[2].SoftDep[8].upgradeCode" Type="Str">{699C1AC5-2CF2-4745-9674-B19536EBA8A3}</Property>
				<Property Name="DistPart[2].SoftDep[9].exclude" Type="Bool">false</Property>
				<Property Name="DistPart[2].SoftDep[9].productName" Type="Str">Math Kernel Libraries 2020</Property>
				<Property Name="DistPart[2].SoftDep[9].upgradeCode" Type="Str">{9872BBBA-FB96-42A4-80A2-9605AC5CBCF1}</Property>
				<Property Name="DistPart[2].upgradeCode" Type="Str">{32C926F2-5C92-3338-8348-97AFEFCAD100}</Property>
				<Property Name="InstSpecBitness" Type="Str">32-bit</Property>
				<Property Name="InstSpecVersion" Type="Str">22318008</Property>
				<Property Name="INST_author" Type="Str">tufts university</Property>
				<Property Name="INST_autoIncrement" Type="Bool">true</Property>
				<Property Name="INST_buildLocation" Type="Path">../builds/ObieAppInstaller/ObieInstaller</Property>
				<Property Name="INST_buildLocation.type" Type="Str">relativeToCommon</Property>
				<Property Name="INST_buildSpecName" Type="Str">ObieInstaller</Property>
				<Property Name="INST_defaultDir" Type="Str">{05DEC322-9B94-4042-BFC3-F35B64D3F010}</Property>
				<Property Name="INST_installerName" Type="Str">install.exe</Property>
				<Property Name="INST_productName" Type="Str">ObieAppInstaller</Property>
				<Property Name="INST_productVersion" Type="Str">1.0.9</Property>
				<Property Name="MSI_arpCompany" Type="Str">Tufts University</Property>
				<Property Name="MSI_distID" Type="Str">{9EDEB9C5-B15F-4238-B0E9-73935B649077}</Property>
				<Property Name="MSI_hideNonRuntimes" Type="Bool">true</Property>
				<Property Name="MSI_osCheck" Type="Int">0</Property>
				<Property Name="MSI_upgradeCode" Type="Str">{95479C86-D657-453A-B025-058D2E8A41E3}</Property>
				<Property Name="MSI_windowMessage" Type="Str">Welcome to the PC Installer</Property>
				<Property Name="MSI_windowTitle" Type="Str">ObieApp</Property>
				<Property Name="RegDestCount" Type="Int">1</Property>
				<Property Name="RegDest[0].dirName" Type="Str">Software</Property>
				<Property Name="RegDest[0].dirTag" Type="Str">{DDFAFC8B-E728-4AC8-96DE-B920EBB97A86}</Property>
				<Property Name="RegDest[0].parentTag" Type="Str">2</Property>
				<Property Name="SourceCount" Type="Int">1</Property>
				<Property Name="Source[0].dest" Type="Str">{05DEC322-9B94-4042-BFC3-F35B64D3F010}</Property>
				<Property Name="Source[0].FileCount" Type="Int">1</Property>
				<Property Name="Source[0].File[0].dest" Type="Str">{05DEC322-9B94-4042-BFC3-F35B64D3F010}</Property>
				<Property Name="Source[0].File[0].name" Type="Str">ObieApp.exe</Property>
				<Property Name="Source[0].File[0].ShortcutCount" Type="Int">2</Property>
				<Property Name="Source[0].File[0].Shortcut[0].destIndex" Type="Int">0</Property>
				<Property Name="Source[0].File[0].Shortcut[0].name" Type="Str">ObieApp</Property>
				<Property Name="Source[0].File[0].Shortcut[0].subDir" Type="Str">OberlinAcoustics</Property>
				<Property Name="Source[0].File[0].Shortcut[1].destIndex" Type="Int">1</Property>
				<Property Name="Source[0].File[0].Shortcut[1].name" Type="Str">ObieApp</Property>
				<Property Name="Source[0].File[0].Shortcut[1].subDir" Type="Str"></Property>
				<Property Name="Source[0].File[0].tag" Type="Str">{BE542A28-E24F-458B-9D8A-329DB32A870C}</Property>
				<Property Name="Source[0].name" Type="Str">Oberlin Acoustics</Property>
				<Property Name="Source[0].tag" Type="Ref">/My Computer/Build Specifications/Oberlin Acoustics</Property>
				<Property Name="Source[0].type" Type="Str">EXE</Property>
			</Item>
		</Item>
	</Item>
</Project>
